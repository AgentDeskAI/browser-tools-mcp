import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { AUDIT_BROWSER_PREFS, proxyChromeFlags, startEgressProxy } from "../../src/lighthouse/egress-proxy";

/**
 * The proxy every audit-browser request goes through. Redirects, frames and
 * subresources are where an up-front url check stops helping, so the policy
 * has to hold here, per request.
 */
let internal: http.Server;
let internalPort: number;

beforeAll(async () => {
  internal = http.createServer((_req, res) => res.end("INTERNAL-SECRET"));
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
  internalPort = (internal.address() as AddressInfo).port;
});

afterAll(() => internal.close());

function viaProxy(proxyPort: number, absoluteUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: absoluteUrl }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** An upstream that answers every connection with `respond`, bytes as written, for replies no http.Server would send. */
async function rawUpstream(respond: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => respond(socket));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => r());
      }),
  };
}

function connectVia(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.once("data", (d) => {
      resolve(d.toString().split("\r\n")[0]!);
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

describe("audit egress proxy", () => {
  it("refuses loopback when private destinations are not allowed (public page framing localhost)", async () => {
    const proxy = await startEgressProxy({ allowPrivate: false });
    try {
      const res = await viaProxy(proxy.port, `http://127.0.0.1:${internalPort}/`);
      expect(res.status).toBe(403);
      expect(res.body).not.toContain("INTERNAL-SECRET");
      expect(await connectVia(proxy.port, `127.0.0.1:${internalPort}`)).toMatch(/403/);
      expect(await connectVia(proxy.port, `[::1]:${internalPort}`)).toMatch(/403/);
    } finally {
      await proxy.close();
    }
  });

  it("refuses names that resolve to private addresses (DNS rebinding, internal hostnames)", async () => {
    const proxy = await startEgressProxy({ allowPrivate: false, lookup: async () => ["10.1.2.3"] });
    try {
      expect((await viaProxy(proxy.port, "http://intranet.test/")).status).toBe(403);
      expect(await connectVia(proxy.port, "intranet.test:443")).toMatch(/403/);
    } finally {
      await proxy.close();
    }
  });

  it("never reaches metadata or reserved addresses, even when private ones are allowed", async () => {
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      // Refused before any connection is attempted; nothing leaves this machine.
      expect((await viaProxy(proxy.port, "http://169.254.169.254/latest/meta-data/")).status).toBe(403);
      expect((await viaProxy(proxy.port, "http://[::ffff:a9fe:a9fe]/")).status).toBe(403);
      expect(await connectVia(proxy.port, "192.0.2.1:443")).toMatch(/403/);
      expect(proxy.refused.map((r) => r.class)).toEqual(["blocked", "blocked", "blocked"]);
    } finally {
      await proxy.close();
    }
  });

  it("connects to the address it vetted rather than resolving again", async () => {
    const proxy = await startEgressProxy({ allowPrivate: true, lookup: async () => ["127.0.0.1"] });
    try {
      const res = await viaProxy(proxy.port, `http://dev.test:${internalPort}/`);
      expect(res.status).toBe(200);
      expect(res.body).toBe("INTERNAL-SECRET");
      expect(await connectVia(proxy.port, `dev.test:${internalPort}`)).toMatch(/200/);
    } finally {
      await proxy.close();
    }
  });

  /**
   * localhost resolves to ::1 first on macOS and most Linux hosts, and a dev
   * server is very often bound to 127.0.0.1 only. A browser tries both; behind
   * the proxy, the proxy has to, or `http://localhost:3000` stops auditing.
   */
  it("falls back to the next vetted address when the first refuses the connection", async () => {
    // The internal server listens on 127.0.0.1 only, so ::1 is refused.
    const proxy = await startEgressProxy({ allowPrivate: true, lookup: async () => ["::1", "127.0.0.1"] });
    try {
      const res = await viaProxy(proxy.port, `http://dev.test:${internalPort}/`);
      expect(res.status).toBe(200);
      expect(res.body).toBe("INTERNAL-SECRET");
      expect(await connectVia(proxy.port, `dev.test:${internalPort}`)).toMatch(/200/);
      // Same for a bare localhost name, which never goes through DNS at all.
      expect((await viaProxy(proxy.port, `http://localhost:${internalPort}/`)).status).toBe(200);
      expect(await connectVia(proxy.port, `app.localhost:${internalPort}`)).toMatch(/200/);
    } finally {
      await proxy.close();
    }
  });

  it("answers 502, not a hang, when no vetted address accepts the connection", async () => {
    const proxy = await startEgressProxy({ allowPrivate: true, lookup: async () => ["127.0.0.1"] });
    try {
      const closedPort = await (async () => {
        const probe = http.createServer();
        await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
        const port = (probe.address() as AddressInfo).port;
        await new Promise<void>((r) => probe.close(() => r()));
        return port;
      })();
      expect((await viaProxy(proxy.port, `http://dev.test:${closedPort}/`)).status).toBe(502);
      expect(await connectVia(proxy.port, `dev.test:${closedPort}`)).toMatch(/502/);
    } finally {
      await proxy.close();
    }
  });

  /**
   * Vouching for one local origin (the dev server open in a tab) must not
   * vouch for the rest of the machine or the LAN: an open redirect such as
   * /login?next=http://127.0.0.1:8500/ would otherwise carry the audit there.
   */
  it("allows only the vouched local origins when private access is not wholesale", async () => {
    const otherPort = internalPort === 65535 ? internalPort - 1 : internalPort + 1;
    const proxy = await startEgressProxy({
      allowPrivate: false,
      allowedOrigins: [`http://localhost:${internalPort}`],
      lookup: async (host) => (host === "router.test" ? ["192.168.1.1"] : ["93.184.215.14"]),
    });
    try {
      // The vouched origin, by any loopback spelling of it.
      expect((await viaProxy(proxy.port, `http://localhost:${internalPort}/`)).status).toBe(200);
      expect((await viaProxy(proxy.port, `http://127.0.0.1:${internalPort}/`)).status).toBe(200);
      expect(await connectVia(proxy.port, `[::1]:${internalPort}`)).toMatch(/200|502/);
      expect(await connectVia(proxy.port, `127.0.0.1:${internalPort}`)).toMatch(/200/);

      // Another port on this machine, and the LAN: not vouched.
      expect((await viaProxy(proxy.port, `http://127.0.0.1:${otherPort}/`)).status).toBe(403);
      expect(await connectVia(proxy.port, `localhost:${otherPort}`)).toMatch(/403/);
      expect((await viaProxy(proxy.port, "http://router.test/")).status).toBe(403);
      expect((await viaProxy(proxy.port, "http://192.168.1.1/")).status).toBe(403);
      // NAT64 of 127.0.0.1 is classed loopback but would leave the machine
      // for a translator: not the vouched port on this machine.
      expect(await connectVia(proxy.port, `[64:ff9b::7f00:1]:${internalPort}`)).toMatch(/403/);
      expect(proxy.refused.map((r) => r.class)).toEqual(["loopback", "loopback", "private", "private", "loopback"]);
      expect(proxy.refused[0]).toEqual({ host: "127.0.0.1", port: otherPort, class: "loopback" });
    } finally {
      await proxy.close();
    }
  });

  it("asks DNS once per host for the whole audit", async () => {
    const asked: string[] = [];
    const proxy = await startEgressProxy({
      allowPrivate: true,
      lookup: async (host) => {
        asked.push(host);
        return ["127.0.0.1"];
      },
    });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await viaProxy(proxy.port, `http://dev.test:${internalPort}/${i}`)).status).toBe(200);
      }
      expect(await connectVia(proxy.port, `DEV.test.:${internalPort}`)).toMatch(/200/);
      expect(asked).toEqual(["dev.test"]);
    } finally {
      await proxy.close();
    }
  });

  /**
   * --audit-allow-private-network lets a page reach any local port, but the
   * audit's own machinery is not a page: the audit browser's DevTools port
   * and the proxy itself stay out of reach.
   */
  it("keeps its own port and the audit browser's DevTools port refused, even with private access", async () => {
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      expect((await viaProxy(proxy.port, `http://127.0.0.1:${proxy.port}/`)).status).toBe(403);
      expect(await connectVia(proxy.port, `localhost:${proxy.port}`)).toMatch(/403/);

      expect((await viaProxy(proxy.port, `http://127.0.0.1:${internalPort}/json/version`)).status).toBe(200);
      proxy.refusePort(internalPort);
      expect((await viaProxy(proxy.port, `http://127.0.0.1:${internalPort}/json/version`)).status).toBe(403);
      expect(await connectVia(proxy.port, `[::1]:${internalPort}`)).toMatch(/403/);
    } finally {
      await proxy.close();
    }
  });

  /**
   * Hop-by-hop headers belong to one connection (RFC 9110 section 7.6.1).
   * Passed through, Chrome's Upgrade or the upstream's Connection: close
   * would act on the wrong connection.
   */
  it("does not pass hop-by-hop headers through in either direction", async () => {
    let received: http.IncomingHttpHeaders = {};
    const echo = http.createServer((req, res) => {
      received = req.headers;
      res.writeHead(200, {
        "content-type": "text/plain",
        connection: "keep-alive, x-upstream-hop",
        "keep-alive": "timeout=1",
        "x-upstream-hop": "1",
        "x-upstream-end": "1",
      });
      res.end("ok");
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    const port = (echo.address() as AddressInfo).port;
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: proxy.port,
          method: "GET",
          path: `http://127.0.0.1:${port}/`,
          headers: {
            connection: "keep-alive, x-client-hop",
            "keep-alive": "timeout=5",
            upgrade: "h2c",
            te: "trailers",
            "proxy-connection": "keep-alive",
            "x-client-hop": "1",
            "x-client-end": "1",
          },
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res);
        });
        req.on("error", reject);
        req.end();
      });
      expect(response.statusCode).toBe(200);
      for (const name of ["keep-alive", "upgrade", "te", "proxy-connection", "x-client-hop"]) {
        expect(received[name], `upstream got ${name}`).toBeUndefined();
      }
      expect(received["x-client-end"]).toBe("1");
      // The proxy's own server sets Keep-Alive for its own connection; the
      // upstream's timeout=1 must not be what Chrome sees.
      expect(response.headers["keep-alive"]).not.toBe("timeout=1");
      expect(response.headers["x-upstream-hop"]).toBeUndefined();
      expect(response.headers["x-upstream-end"]).toBe("1");
    } finally {
      await proxy.close();
      echo.closeAllConnections();
      await new Promise<void>((r) => echo.close(() => r()));
    }
  });

  /**
   * Node's HTTP client accepts any three-digit status, but a server response
   * cannot carry one under 100: relaying it threw out of the response
   * callback and took the connector, and the MCP server around it, down. Any
   * public page the audit loads can send one.
   */
  it("answers 502 for an upstream status it cannot relay, and keeps running", async () => {
    const upstreams = await Promise.all(
      ["000", "099"].map((status) =>
        rawUpstream((socket) => socket.end(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\n\r\n`))
      )
    );
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      for (const upstream of upstreams) {
        expect((await viaProxy(proxy.port, `http://127.0.0.1:${upstream.port}/`)).status).toBe(502);
      }
      expect((await viaProxy(proxy.port, `http://127.0.0.1:${internalPort}/`)).body).toBe("INTERNAL-SECRET");
    } finally {
      await proxy.close();
      await Promise.all(upstreams.map((upstream) => upstream.close()));
    }
  });

  /**
   * A response that breaks off must reach the browser broken. Finished
   * cleanly instead, a truncated script runs and is reported as loaded; left
   * open, the page never finishes loading and the audit waits out its timeout.
   */
  it("passes on an upstream response that breaks off mid-body, rather than ending or stalling it", async () => {
    const replies = [
      // Reset after part of a chunked body.
      (socket: net.Socket) => {
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n");
        setTimeout(() => socket.resetAndDestroy(), 20);
      },
      // Closed before the promised Content-Length, and before the last chunk.
      (socket: net.Socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhello"),
      (socket: net.Socket) => socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n"),
    ];
    const upstreams = await Promise.all(replies.map((reply) => rawUpstream(reply)));
    const proxy = await startEgressProxy({ allowPrivate: true });
    const outcome = (port: number) =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("still open"), 3_000);
        const req = http.request(
          { host: "127.0.0.1", port: proxy.port, method: "GET", path: `http://127.0.0.1:${port}/app.js` },
          (res) => {
            res.resume();
            res.on("error", () => undefined);
            res.on("close", () => {
              clearTimeout(timer);
              resolve(res.complete ? "complete" : "broken");
            });
          }
        );
        req.on("error", () => {
          clearTimeout(timer);
          resolve("broken");
        });
        req.end();
      });
    try {
      for (const upstream of upstreams) expect(await outcome(upstream.port)).toBe("broken");
    } finally {
      await proxy.close();
      await Promise.all(upstreams.map((upstream) => upstream.close()));
    }
  });

  /**
   * Transfer-Encoding is what says where a request body ends. Without it, a
   * chunked DELETE or OPTIONS body went upstream unframed on a pooled
   * connection, where the server read it as the next request.
   */
  it("keeps a request body framed as it arrived", async () => {
    const received: Array<{ method?: string; url?: string; body: string }> = [];
    const echo = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, body });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    const port = (echo.address() as AddressInfo).port;
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: proxy.port,
            method: "DELETE",
            path: `http://127.0.0.1:${port}/item`,
            headers: { "transfer-encoding": "chunked" },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          }
        );
        req.on("error", reject);
        req.end("GET /smuggled HTTP/1.1\r\nHost: evil.example\r\n\r\n");
      });
      expect(status).toBe(200);
      expect((await viaProxy(proxy.port, `http://127.0.0.1:${port}/next`)).body).toBe("ok");
      expect(received).toEqual([
        { method: "DELETE", url: "/item", body: "GET /smuggled HTTP/1.1\r\nHost: evil.example\r\n\r\n" },
        { method: "GET", url: "/next", body: "" },
      ]);
    } finally {
      await proxy.close();
      echo.closeAllConnections();
      await new Promise<void>((r) => echo.close(() => r()));
    }
  });

  it("does not connect upstream for a request cancelled while its host was being looked up", async () => {
    let connections = 0;
    const counting = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((r) => counting.listen(0, "127.0.0.1", () => r()));
    const port = (counting.address() as AddressInfo).port;
    const proxy = await startEgressProxy({
      allowPrivate: true,
      lookup: () => new Promise((resolve) => setTimeout(() => resolve(["127.0.0.1"]), 300)),
    });
    try {
      for (let i = 0; i < 3; i++) {
        const req = http.request({ host: "127.0.0.1", port: proxy.port, path: `http://slow${i}.test:${port}/` });
        req.on("error", () => undefined);
        req.end();
        setTimeout(() => req.destroy(), 50);
      }
      await new Promise((r) => setTimeout(r, 700));
      expect(connections).toBe(0);
    } finally {
      await proxy.close();
      await new Promise<void>((r) => counting.close(() => r()));
    }
  });

  it("does not hold on to a failed lookup for the rest of the audit", async () => {
    let attempts = 0;
    const proxy = await startEgressProxy({
      allowPrivate: true,
      lookup: async () => {
        attempts++;
        if (attempts === 1) throw new Error("EAI_AGAIN");
        return ["127.0.0.1"];
      },
    });
    try {
      // Fails closed on the hiccup itself...
      expect((await viaProxy(proxy.port, `http://flaky.test:${internalPort}/`)).status).toBe(403);
      // ...and asks again next time rather than refusing the host for good.
      expect((await viaProxy(proxy.port, `http://flaky.test:${internalPort}/`)).status).toBe(200);
      expect((await viaProxy(proxy.port, `http://flaky.test:${internalPort}/`)).status).toBe(200);
      expect(attempts).toBe(2);
    } finally {
      await proxy.close();
    }
  });

  it("stops the upstream transfer when the browser cancels the request", async () => {
    let upstreamClosed = false;
    const streaming = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const timer = setInterval(() => res.write(Buffer.alloc(16_384)), 20);
      req.socket.once("close", () => {
        clearInterval(timer);
        upstreamClosed = true;
      });
    });
    await new Promise<void>((r) => streaming.listen(0, "127.0.0.1", () => r()));
    const port = (streaming.address() as AddressInfo).port;
    const proxy = await startEgressProxy({ allowPrivate: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: proxy.port, method: "GET", path: `http://127.0.0.1:${port}/video` },
          (res) => res.once("data", () => {
            req.destroy();
            resolve();
          })
        );
        req.on("error", (error) => (error.message.includes("socket hang up") ? undefined : reject(error)));
        req.end();
      });
      await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 3_000 });
    } finally {
      await proxy.close();
      streaming.closeAllConnections();
      await new Promise<void>((r) => streaming.close(() => r()));
    }
  });

  it("closes without waiting on open tunnels", async () => {
    const proxy = await startEgressProxy({ allowPrivate: true, lookup: async () => ["127.0.0.1"] });
    const socket = net.connect(proxy.port, "127.0.0.1");
    await new Promise<void>((r) => socket.once("connect", () => r()));
    socket.write(`CONNECT 127.0.0.1:${internalPort} HTTP/1.1\r\nHost: 127.0.0.1:${internalPort}\r\n\r\n`);
    await new Promise<void>((r) => socket.once("data", () => r()));
    const started = Date.now();
    await proxy.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    await new Promise<void>((r) => (socket.destroyed ? r() : socket.once("close", () => r())));
  });
});

describe("audit browser flags", () => {
  it("routes everything through the proxy and keeps WebRTC off direct UDP", () => {
    expect(proxyChromeFlags(4321)).toEqual([
      "--proxy-server=http://127.0.0.1:4321",
      "--proxy-bypass-list=<-loopback>",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]);
    expect(AUDIT_BROWSER_PREFS).toEqual({ webrtc: { ip_handling_policy: "disable_non_proxied_udp" } });
  });
});
