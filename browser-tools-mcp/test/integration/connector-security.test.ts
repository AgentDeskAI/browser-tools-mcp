import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import WebSocket from "ws";
import { createConnector, type Connector } from "../../src/connector/connector";
import { tryWebSocket, TINY_PNG_BASE64, FakeExtension } from "../helpers/fake-extension";

/**
 * These are the regression tests for the vulnerabilities that were live in
 * 1.2.x: an unauthenticated, LAN-reachable control plane with wildcard CORS,
 * and a screenshot path that reached a shell.
 */

let connector: Connector;
let screenshotDir: string;

beforeAll(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-sec-"));
  connector = await createConnector({ port: 0, screenshotDir });
});

afterAll(async () => {
  await connector?.close();
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

describe("network exposure", () => {
  it("binds loopback only, never 0.0.0.0", () => {
    const address = connector.server.address();
    expect(address).toBeTypeOf("object");
    expect((address as any).address).toBe("127.0.0.1");
  });

  it("refuses to bind a non-loopback interface without an explicit override", async () => {
    await expect(createConnector({ port: 0, host: "0.0.0.0" })).rejects.toThrow(
      /loopback/i
    );
  });
});

describe("CORS and origin handling", () => {
  it("never emits a wildcard access-control-allow-origin", async () => {
    const res = await request(connector.app).get("/.identity");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not answer preflight with permissive headers", async () => {
    const res = await request(connector.app)
      .options("/api/console")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects API requests carrying a web page origin, even with a valid token", async () => {
    const res = await request(connector.app)
      .get("/api/console")
      .set("Origin", "https://evil.example")
      .set("Authorization", `Bearer ${connector.token}`);

    expect(res.status).toBe(403);
  });

  it("rejects requests with a foreign Host header (DNS rebinding)", async () => {
    const res = await request(connector.app)
      .get("/api/console")
      .set("Host", "attacker.example.com")
      .set("Authorization", `Bearer ${connector.token}`);

    expect(res.status).toBe(403);
  });
});

describe("HTTP authentication", () => {
  const protectedRoutes: Array<[string, string]> = [
    ["get", "/api/console"],
    ["get", "/api/network"],
    ["get", "/api/selected-element"],
    ["get", "/api/page"],
    ["post", "/api/wipe"],
    ["post", "/api/screenshot"],
    ["post", "/api/refresh"],
    ["post", "/api/storage"],
  ];

  for (const [method, route] of protectedRoutes) {
    it(`rejects unauthenticated ${method.toUpperCase()} ${route}`, async () => {
      const res = await (request(connector.app) as any)[method](route);
      expect(res.status).toBe(401);
    });
  }

  it("rejects a wrong token", async () => {
    const res = await request(connector.app)
      .get("/api/console")
      .set("Authorization", "Bearer not-the-token");
    expect(res.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const res = await request(connector.app)
      .get("/api/console")
      .set("Authorization", `Bearer ${connector.token}`);
    expect(res.status).toBe(200);
  });

  it("leaves the identity endpoint public so the extension can find the server", async () => {
    const res = await request(connector.app).get("/.identity");
    expect(res.status).toBe(200);
    expect(res.body.signature).toBe("mcp-browser-connector-24x7");
  });

  it("does not leak the token from the identity endpoint", async () => {
    const res = await request(connector.app).get("/.identity");
    expect(JSON.stringify(res.body)).not.toContain(connector.token);
  });
});

describe("websocket upgrade", () => {
  it("accepts a chrome extension origin", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`,
      { origin: "chrome-extension://abcdefghijklmnop" }
    );
    expect(result.accepted).toBe(true);
  });

  it("accepts a firefox extension origin", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`,
      { origin: "moz-extension://abcdefghijklmnop" }
    );
    expect(result.accepted).toBe(true);
  });

  // The core of the old vulnerability: any visited web page could open this
  // socket and impersonate the extension.
  it("rejects a web page origin", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`,
      { origin: "https://evil.example" }
    );
    expect(result.accepted).toBe(false);
  });

  it("rejects an http localhost origin", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`,
      { origin: "http://localhost:3000" }
    );
    expect(result.accepted).toBe(false);
  });

  it("rejects an originless connection that has no token", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`
    );
    expect(result.accepted).toBe(false);
  });

  it("allows an originless connection that presents the token", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws?token=${connector.token}`
    );
    expect(result.accepted).toBe(true);
  });

  it("rejects unknown websocket paths", async () => {
    const result = await tryWebSocket(`ws://127.0.0.1:${connector.port}/anything`, {
      origin: "chrome-extension://abcdefghijklmnop",
    });
    expect(result.accepted).toBe(false);
  });
});

describe("screenshot path handling", () => {
  it("keeps caller-supplied names inside the screenshot directory", async () => {
    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ name: "../../escape.png" });

    // No extension is connected, so this cannot succeed — but it must fail on
    // the path, not attempt the write.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(path.join(screenshotDir, "..", "..", "escape.png"))).toBe(false);
  });

  it("rejects names containing shell metacharacters", async () => {
    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ name: "shot'$(touch /tmp/pwned).png" });

    expect(res.status).toBe(400);
  });

  it("never accepts an absolute path", async () => {
    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ name: "/tmp/anywhere.png" });

    expect(res.status).toBe(400);
  });
});

describe("settings hardening", () => {
  it("ignores unknown settings keys pushed over the API", async () => {
    await request(connector.app)
      .post("/api/settings")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ logLimit: 10, screenshotPath: "/etc", serverHost: "0.0.0.0" })
      .expect(200);

    expect(connector.store.settings.logLimit).toBe(10);
    expect(connector.store.settings).not.toHaveProperty("screenshotPath");
    expect(connector.store.settings).not.toHaveProperty("serverHost");
  });

  it("clamps a hostile log limit instead of exhausting memory", async () => {
    await request(connector.app)
      .post("/api/settings")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ logLimit: 1e9 })
      .expect(200);

    expect(connector.store.settings.logLimit).toBeLessThanOrEqual(5_000);
  });
});

describe("request body limits", () => {
  it("rejects an oversized body rather than buffering it", async () => {
    const huge = TINY_PNG_BASE64.repeat(200_000); // well over the limit
    const res = await request(connector.app)
      .post("/api/settings")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ blob: huge });

    expect(res.status).toBe(413);
  });
});

/**
 * SSRF through the audit tools (CWE-918). Through 2.0.2 an audit accepted any
 * http(s) url, so a caller could make the audit browser load loopback, LAN or
 * cloud metadata addresses and read the page back from the stored report's
 * screenshot.
 */
describe("audit destination policy", () => {
  let guarded: Connector;
  let guardedDir: string;
  const audited: Array<{ url: string; allowPrivate: boolean | undefined; allowedOrigins?: string[] }> = [];
  // What the attacker's name resolves to; flipped to stage a DNS rebinding.
  let rebindTo = "93.184.215.14";

  beforeAll(async () => {
    guardedDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-ssrf-"));
    guarded = await createConnector({
      port: 0,
      screenshotDir: guardedDir,
      auditLookup: async (host) =>
        host === "intranet.test" ? ["10.0.0.7"] : host === "rebind.example.com" ? [rebindTo] : ["93.184.215.14"],
      auditRunner: async ({ url, category, egress }) => {
        audited.push({
          url,
          allowPrivate: egress?.allowPrivate,
          ...(egress?.allowedOrigins?.length ? { allowedOrigins: egress.allowedOrigins } : {}),
        });
        return { category, score: 100, metadata: { url }, summary: {}, issues: [] } as any;
      },
    });
  });

  async function openTab(tabId: number, url: string): Promise<FakeExtension> {
    const ext = new FakeExtension({ port: guarded.port, tabId });
    await ext.connect();
    await ext.waitForWelcome();
    ext.send({ type: "page", url, tabId });
    await vi.waitFor(() => {
      expect(guarded.listTabs().find((t) => t.tabId === tabId)?.url).toBe(url);
    });
    return ext;
  }

  afterAll(async () => {
    await guarded?.close();
    fs.rmSync(guardedDir, { recursive: true, force: true });
  });

  async function audit(url: string) {
    return request(guarded.app)
      .post("/api/audit/performance")
      .set("Authorization", `Bearer ${guarded.token}`)
      .send({ url });
  }

  it.each([
    "http://127.0.0.1:18742/",
    "http://localhost:6379/",
    "http://app.localhost/",
    "http://[::1]/",
    "http://2130706433/",
    "http://192.168.1.1/",
    "http://10.0.0.1/",
    "http://intranet.test/",
  ])("refuses an internal url that no open tab vouches for: %s", async (url) => {
    const before = audited.length;
    const res = await audit(url);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not open in a connected browser tab/);
    expect(audited.length).toBe(before);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:169.254.169.254]/",
    "http://metadata.google.internal/",
    "http://0.0.0.0:8080/",
  ])("always refuses metadata and reserved addresses: %s", async (url) => {
    const before = audited.length;
    const res = await audit(url);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/link-local|metadata|reserved/);
    expect(audited.length).toBe(before);
  });

  it("audits public sites, without letting them reach private addresses", async () => {
    const res = await audit("https://example.com/");
    expect(res.status).toBe(200);
    expect(audited.at(-1)).toEqual({ url: "https://example.com/", allowPrivate: false });
  });

  it("audits a localhost page the user has open in a connected tab", async () => {
    const ext = await openTab(1, "http://localhost:3000/dashboard");
    try {
      const res = await audit("http://localhost:3000/other-route");
      expect(res.status).toBe(200);
      // The page may load its own origin and nothing else local: not every
      // loopback and private address, which an open redirect would reach.
      expect(audited.at(-1)).toEqual({
        url: "http://localhost:3000/other-route",
        allowPrivate: false,
        allowedOrigins: ["http://localhost:3000"],
      });

      // Same host, different port: a different service, not vouched for.
      expect((await audit("http://localhost:3001/")).status).toBe(422);

      // The same port under another loopback spelling is the same server.
      expect((await audit("http://127.0.0.1:3000/")).status).toBe(200);
      expect(audited.at(-1)!.allowedOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
    } finally {
      await ext.close();
    }
  });

  it("lets a vouched local page load the other vouched origins, and only those", async () => {
    const app = await openTab(2, "http://localhost:5173/");
    const api = await openTab(3, "http://192.168.1.20:8000/docs");
    const elsewhere = await openTab(4, "https://example.com/");
    try {
      expect((await audit("http://localhost:5173/")).status).toBe(200);
      const allowed = audited.at(-1)!.allowedOrigins ?? [];
      expect(allowed).toEqual(expect.arrayContaining(["http://localhost:5173", "http://192.168.1.20:8000"]));
      // A tab on a public site vouches for nothing local.
      expect(allowed).not.toContain("https://example.com:443");
    } finally {
      await Promise.all([app.close(), api.close(), elsewhere.close()]);
    }
  });

  /**
   * DNS rebinding through a tab: the user browses rebind.example.com (public
   * when they load it), its owner then points the name at the LAN, and a
   * prompt injection on the page asks for an audit of it. A tab vouches for
   * the name, not for whatever the name's owner points it at next.
   */
  it("does not let a tab on a public name vouch for it once it points inside", async () => {
    const ext = await openTab(5, "http://rebind.example.com/");
    try {
      const before = audited.length;
      rebindTo = "10.0.0.5";
      const res = await audit("http://rebind.example.com/");
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/public DNS name/);
      expect(audited.length).toBe(before);

      // Pointed back at a public address, it is an ordinary public audit.
      rebindTo = "93.184.215.14";
      expect((await audit("http://rebind.example.com/")).status).toBe(200);
      expect(audited.at(-1)).toEqual({ url: "http://rebind.example.com/", allowPrivate: false });
    } finally {
      rebindTo = "93.184.215.14";
      await ext.close();
    }
  });

  it("stops vouching for a page once its tab is gone", async () => {
    const ext = await openTab(6, "http://localhost:7000/");
    expect((await audit("http://localhost:7000/")).status).toBe(200);
    await ext.close();
    await vi.waitFor(() => expect(guarded.listTabs().find((t) => t.tabId === 6)).toBeUndefined());

    const res = await audit("http://localhost:7000/");
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not open in a connected browser tab/);
  });

  /**
   * An extension that never sends hello has no tab, so its page is vouched
   * for through the socket that reported it, and only while it is open. Its
   * mere presence must not bring back a page from a tab that has closed: the
   * store's current page, which nothing clears, still names it.
   */
  it("vouches for an untabbed extension's own page only while its socket is open", async () => {
    const closed = await openTab(7, "http://localhost:7200/");
    await closed.close();
    await vi.waitFor(() => expect(guarded.listTabs()).toEqual([]));

    const legacy = new WebSocket(`ws://127.0.0.1:${guarded.port}/extension-ws`, {
      origin: "chrome-extension://legacyextension",
    });
    await new Promise<void>((resolve, reject) => {
      legacy.once("open", () => resolve());
      legacy.once("error", reject);
    });
    try {
      expect((await audit("http://localhost:7200/")).status).toBe(422);

      legacy.send(JSON.stringify({ type: "page", url: "http://localhost:7100/" }));
      await vi.waitFor(async () => expect((await audit("http://localhost:7100/")).status).toBe(200));
      expect((await audit("http://localhost:7200/")).status).toBe(422);
    } finally {
      await new Promise<void>((resolve) => {
        legacy.once("close", () => resolve());
        legacy.close();
      });
    }
    await vi.waitFor(async () => expect((await audit("http://localhost:7100/")).status).toBe(422));
  });

  it("refuses a url with embedded credentials before deciding anything else", async () => {
    const before = audited.length;
    const res = await audit("https://user:pass@example.com/");
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/embeds credentials/);
    expect(audited.length).toBe(before);
  });

  it("honours --audit-allow-origin, with or without a scheme, by scheme, host and port", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-ssrf-allow-"));
    const ran: string[] = [];
    const allowed = await createConnector({
      port: 0,
      screenshotDir: dir,
      auditAllowedOrigins: ["http://localhost:4000", "127.0.0.1:5000", "http://192.168.1.50/", "chrome://x"],
      auditLookup: async () => ["93.184.215.14"],
      auditRunner: async ({ url, category }) => {
        ran.push(url);
        return { category, score: 100, metadata: { url }, summary: {}, issues: [] } as any;
      },
    });
    try {
      const post = (url: string) =>
        request(allowed.app)
          .post("/api/audit/seo")
          .set("Authorization", `Bearer ${allowed.token}`)
          .send({ url });
      expect((await post("http://localhost:4000/page")).status).toBe(200);
      expect((await post("http://127.0.0.1:5000/")).status).toBe(200);
      expect((await post("http://192.168.1.50/admin")).status).toBe(200);
      // Another spelling of this machine is the same host, as the egress proxy
      // already treats it: localhost:4000 and 127.0.0.1:4000 are one port.
      expect((await post("http://127.0.0.1:4000/")).status).toBe(200);
      expect((await post("http://[::1]:4000/")).status).toBe(200);
      // Different port, scheme or host: not the allowlisted origin.
      expect((await post("http://localhost:4001/")).status).toBe(422);
      expect((await post("https://localhost:4000/")).status).toBe(422);
      expect((await post("http://192.168.1.51/")).status).toBe(422);
      // The allowlist never reaches metadata or link-local, even if named.
      expect((await post("http://169.254.169.254/")).status).toBe(422);
      expect(ran).toHaveLength(5);
    } finally {
      await allowed.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
