import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createConnector, type Connector } from "../../src/connector/connector";
import { FakeExtension, TINY_PNG_BASE64 } from "../helpers/fake-extension";

let connector: Connector;
let extension: FakeExtension | null = null;
let screenshotDir: string;

const auth = () => `Bearer ${connector.token}`;

beforeEach(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-flow-"));
  connector = await createConnector({
    port: 0,
    screenshotDir,
    heartbeatIntervalMs: 200,
    requestTimeoutMs: 3_000,
    allowInput: true,
  });
});

afterEach(async () => {
  await extension?.close();
  extension = null;
  await connector?.close();
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

async function connectExtension(
  options: Partial<ConstructorParameters<typeof FakeExtension>[0]> = {}
): Promise<FakeExtension> {
  const ext = new FakeExtension({ port: connector.port, ...options });
  await ext.connect();
  await ext.waitForWelcome();
  return ext;
}

describe("port binding", () => {
  it("uses the next port when the requested one is taken and does not keep the failed listen", async () => {
    const held = net.createServer();
    await new Promise<void>((resolve) => {
      held.listen(0, "127.0.0.1", () => resolve());
    });
    const taken = (held.address() as net.AddressInfo).port;
    const moved = await createConnector({ port: taken, screenshotDir });
    expect(moved.port).toBe(taken + 1);
    expect(moved.server.listenerCount("listening")).toBeLessThanOrEqual(1);
    expect(moved.server.listenerCount("error")).toBe(1);
    await moved.close();
    await new Promise<void>((resolve) => held.close(() => resolve()));
  });
});

describe("extension handshake", () => {
  it("welcomes a connecting extension and reports it as connected", async () => {
    expect(connector.hasExtension()).toBe(false);
    extension = await connectExtension();
    expect(connector.hasExtension()).toBe(true);
  });

  it("sends current settings in the welcome message", async () => {
    extension = await connectExtension();
    const welcome = await extension.waitFor((m) => m.type === "welcome");
    expect(welcome.settings.logLimit).toBeGreaterThan(0);
  });

  it("reports disconnection after the socket closes", async () => {
    extension = await connectExtension();
    await extension.close();
    extension = null;

    await vi.waitFor(() => expect(connector.hasExtension()).toBe(false), {
      timeout: 3_000,
    });
  });
});

describe("telemetry ingest over the websocket", () => {
  beforeEach(async () => {
    extension = await connectExtension();
  });

  it("accepts console entries and serves them over the API", async () => {
    extension!.send({
      type: "console",
      entries: [
        { type: "console-log", level: "log", message: "MARKER-A", timestamp: Date.now() },
        { type: "console-error", level: "error", message: "BOOM-B", timestamp: Date.now() },
      ],
    });

    await vi.waitFor(async () => {
      const res = await request(connector.app).get("/api/console").set("Authorization", auth());
      expect(res.body.total).toBe(2);
    });

    const errors = await request(connector.app)
      .get("/api/console?errorsOnly=true")
      .set("Authorization", auth());
    expect(errors.body.entries).toHaveLength(1);
    expect(errors.body.entries[0].message).toBe("BOOM-B");
  });

  it("accepts network entries and separates errors", async () => {
    extension!.send({
      type: "network",
      entries: [
        { url: "https://api.test/ok", method: "GET", status: 200, timestamp: Date.now() },
        { url: "https://api.test/bad", method: "POST", status: 500, timestamp: Date.now() },
      ],
    });

    await vi.waitFor(async () => {
      const res = await request(connector.app).get("/api/network").set("Authorization", auth());
      expect(res.body.total).toBe(2);
    });

    const errs = await request(connector.app)
      .get("/api/network?errorsOnly=true")
      .set("Authorization", auth());
    expect(errs.body.entries).toHaveLength(1);
    expect(errs.body.entries[0].status).toBe(500);
  });

  it("redacts credentials arriving from the extension", async () => {
    await request(connector.app)
      .post("/api/settings")
      .set("Authorization", auth())
      .send({ showRequestHeaders: true })
      .expect(200);

    extension!.send({
      type: "network",
      entries: [
        {
          url: "https://api.test/private",
          method: "GET",
          status: 200,
          timestamp: Date.now(),
          requestHeaders: { Authorization: "Bearer super-secret-value-here" },
        },
      ],
    });

    await vi.waitFor(async () => {
      const res = await request(connector.app).get("/api/network").set("Authorization", auth());
      expect(res.body.total).toBe(1);
      expect(JSON.stringify(res.body)).not.toContain("super-secret-value-here");
    });
  });

  it("tracks page navigation and the selected element", async () => {
    extension!.send({ type: "page", url: "https://example.com/x", tabId: 42 });
    extension!.send({ type: "selected-element", element: { tagName: "BUTTON", id: "go" } });

    await vi.waitFor(async () => {
      const page = await request(connector.app).get("/api/page").set("Authorization", auth());
      expect(page.body.url).toBe("https://example.com/x");
    });

    const el = await request(connector.app)
      .get("/api/selected-element")
      .set("Authorization", auth());
    expect(el.body.element.tagName).toBe("BUTTON");
  });

  it("wipes captured telemetry on request", async () => {
    extension!.send({
      type: "console",
      entries: [{ type: "console-log", message: "gone", timestamp: Date.now() }],
    });
    await vi.waitFor(async () => {
      const res = await request(connector.app).get("/api/console").set("Authorization", auth());
      expect(res.body.total).toBe(1);
    });

    await request(connector.app).post("/api/wipe").set("Authorization", auth()).expect(200);

    const after = await request(connector.app).get("/api/console").set("Authorization", auth());
    expect(after.body.total).toBe(0);
  });

  it("ignores malformed websocket frames without dropping the connection", async () => {
    extension!.send({ type: "console", entries: "not-an-array" });
    extension!.send({ type: "totally-unknown-type" });
    extension!.send({ type: "network", entries: [null, 42] });

    // Still healthy afterwards.
    extension!.send({
      type: "console",
      entries: [{ type: "console-log", message: "still-alive", timestamp: Date.now() }],
    });

    await vi.waitFor(async () => {
      const res = await request(connector.app).get("/api/console").set("Authorization", auth());
      expect(res.body.entries.at(-1)?.message).toBe("still-alive");
    });
  });
});

describe("screenshots", () => {
  it("captures a screenshot and writes it into the screenshot directory", async () => {
    extension = await connectExtension();

    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", auth())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.path.startsWith(path.resolve(screenshotDir))).toBe(true);
    expect(fs.existsSync(res.body.path)).toBe(true);
    // Real PNG bytes, not a base64 string written verbatim.
    expect(fs.readFileSync(res.body.path).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
    expect(res.body.data).toContain(TINY_PNG_BASE64.slice(0, 20));
  });

  // Regression: the old implementation resolved screenshot promises by taking
  // the first entry in a callback map and clearing it, so two concurrent
  // captures crossed over and one hung until timeout.
  it("correlates concurrent captures by request id", async () => {
    extension = await connectExtension({
      onScreenshot: async (msg: any) => {
        // Answer out of order: the first request replies last.
        const isFirst = msg.name === "first.png";
        await new Promise((r) => setTimeout(r, isFirst ? 300 : 20));
        return { ok: true, data: `data:image/png;base64,${TINY_PNG_BASE64}` };
      },
    });

    const [a, b] = await Promise.all([
      request(connector.app)
        .post("/api/screenshot")
        .set("Authorization", auth())
        .send({ name: "first.png" }),
      request(connector.app)
        .post("/api/screenshot")
        .set("Authorization", auth())
        .send({ name: "second.png" }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(path.basename(a.body.path)).toBe("first.png");
    expect(path.basename(b.body.path)).toBe("second.png");
  });

  it("fails cleanly when no extension is connected", async () => {
    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", auth())
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/extension/i);
  });

  it("surfaces an extension-side capture failure", async () => {
    extension = await connectExtension({
      onScreenshot: () => ({ ok: false, error: "The tab was closed" }),
    });

    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", auth())
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("tab was closed");
  });

  it("reports a devtools capture failure as a page that cannot be scripted", async () => {
    extension = await connectExtension({
      onScreenshot: () => ({ ok: false, error: "Cannot capture devtools:// URL" }),
    });

    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", auth())
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: "RESTRICTED_PAGE",
      access: "metadata-only",
      message: "metadata only, can't read or act",
      scriptable: false,
      kind: "devtools",
    });
    expect(res.body.url).toContain("devtools://");
  });

  it("times out instead of hanging when the extension never answers", async () => {
    extension = await connectExtension({
      onScreenshot: () => new Promise(() => {}) as any,
    });

    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", auth())
      .send({});

    expect(res.status).toBe(504);
  }, 15_000);
});

describe("browser control", () => {
  it("refreshes the inspected tab", async () => {
    extension = await connectExtension();
    const res = await request(connector.app)
      .post("/api/refresh")
      .set("Authorization", auth())
      .send({});

    expect(res.status).toBe(200);
    expect(extension.received.some((m) => m.type === "refresh-tab")).toBe(true);
  });

  it("reads storage through the extension", async () => {
    extension = await connectExtension({
      onStorage: () => ({
        ok: true,
        storage: {
          localStorage: { theme: "dark" },
          sessionStorage: {},
          cookies: [{ name: "sid", value: "abc" }],
        },
      }),
    });

    const res = await request(connector.app)
      .post("/api/storage")
      .set("Authorization", auth())
      .send({ kinds: ["localStorage", "cookies"] });

    expect(res.status).toBe(200);
    expect(res.body.storage.localStorage.theme).toBe("dark");
  });
});

describe("connection health", () => {
  it("pings connected extensions", async () => {
    extension = await connectExtension();
    await extension.waitFor((m) => m.type === "ping", 3_000);
    expect(connector.hasExtension()).toBe(true);
  });

  // Regression: the old server logged "Unhandled message type: heartbeat" and
  // never detected a socket that had stopped responding.
  it("drops an extension that stops answering pings", async () => {
    const ext = new FakeExtension({ port: connector.port });
    // Swallow pings so the connection looks dead.
    (ext as any).send = function (msg: unknown) {
      const parsed = msg as any;
      if (parsed?.type === "pong") return;
      FakeExtension.prototype.send.call(this, msg);
    };
    await ext.connect();
    extension = ext;

    await vi.waitFor(() => expect(connector.hasExtension()).toBe(false), {
      timeout: 8_000,
    });
  }, 15_000);

  // Regression: the old server kept a single activeConnection that the newest
  // socket silently overwrote, which broke log capture with two DevTools windows.
  it("keeps serving telemetry when a second extension connects and leaves", async () => {
    extension = await connectExtension();
    const second = await connectExtension();

    second.send({
      type: "console",
      entries: [{ type: "console-log", message: "from-second", timestamp: Date.now() }],
    });
    await second.close();

    extension.send({
      type: "console",
      entries: [{ type: "console-log", message: "from-first", timestamp: Date.now() }],
    });

    await vi.waitFor(async () => {
      const res = await request(connector.app).get("/api/console").set("Authorization", auth());
      const messages = res.body.entries.map((e: any) => e.message);
      expect(messages).toContain("from-second");
      expect(messages).toContain("from-first");
    });

    expect(connector.hasExtension()).toBe(true);
  });

  it("survives an abrupt socket teardown without crashing the process", async () => {
    extension = await connectExtension();
    // An unhandled 'error' event on the connection used to take the whole
    // server down with it.
    extension.terminate();
    extension = null;
    await new Promise((r) => setTimeout(r, 200));

    const res = await request(connector.app).get("/api/console").set("Authorization", auth());
    expect(res.status).toBe(200);
  });
});

describe("filtering and pagination over the API", () => {
  beforeEach(async () => {
    extension = await connectExtension();
    extension.send({
      type: "console",
      entries: Array.from({ length: 30 }, (_, i) => ({
        type: "console-log",
        message: `line-${i}`,
        timestamp: Date.now() + i,
      })),
    });
    await vi.waitFor(async () => {
      const res = await request(connector.app).get("/api/console").set("Authorization", auth());
      expect(res.body.total).toBe(30);
    });
  });

  it("applies keyword filters", async () => {
    const res = await request(connector.app)
      .get("/api/console?keywords=line-7")
      .set("Authorization", auth());
    expect(res.body.entries.map((e: any) => e.message)).toContain("line-7");
    expect(res.body.entries.every((e: any) => e.message.includes("line-7"))).toBe(true);
  });

  it("applies limit and offset", async () => {
    const res = await request(connector.app)
      .get("/api/console?limit=5&offset=0")
      .set("Authorization", auth());
    expect(res.body.entries).toHaveLength(5);
    expect(res.body.total).toBe(30);
    expect(res.body.entries.at(-1).message).toBe("line-29");
  });
});
