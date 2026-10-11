import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
