import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
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
  const audited: Array<{ url: string; allowPrivate: boolean | undefined }> = [];

  beforeAll(async () => {
    guardedDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-ssrf-"));
    guarded = await createConnector({
      port: 0,
      screenshotDir: guardedDir,
      auditLookup: async (host) => (host === "intranet.test" ? ["10.0.0.7"] : ["93.184.215.14"]),
      auditRunner: async ({ url, category, egress }) => {
        audited.push({ url, allowPrivate: egress?.allowPrivate });
        return { category, score: 100, metadata: { url }, summary: {}, issues: [] } as any;
      },
    });
  });

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
    const ext = new FakeExtension({ port: guarded.port, tabId: 1 });
    await ext.connect();
    await ext.waitForWelcome();
    ext.send({ type: "page", url: "http://localhost:3000/dashboard", tabId: 1 });
    await vi.waitFor(() => {
      expect(guarded.listTabs().find((t) => t.tabId === 1)?.url).toBe("http://localhost:3000/dashboard");
    });
    try {
      const res = await audit("http://localhost:3000/other-route");
      expect(res.status).toBe(200);
      expect(audited.at(-1)).toEqual({ url: "http://localhost:3000/other-route", allowPrivate: true });

      // Same host, different port: a different service, not vouched for.
      expect((await audit("http://localhost:3001/")).status).toBe(422);
    } finally {
      await ext.close();
    }
  });

  it("honours --audit-allow-origin, with or without a scheme, as an exact origin", async () => {
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
      // Different port, scheme or host: not the allowlisted origin.
      expect((await post("http://localhost:4001/")).status).toBe(422);
      expect((await post("https://localhost:4000/")).status).toBe(422);
      expect((await post("http://127.0.0.1:4000/")).status).toBe(422);
      expect((await post("http://192.168.1.51/")).status).toBe(422);
      // The allowlist never reaches metadata or link-local, even if named.
      expect((await post("http://169.254.169.254/")).status).toBe(422);
      expect(ran).toHaveLength(3);
    } finally {
      await allowed.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
