import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { createConnector, type Connector } from "../../src/connector/connector";
import { HttpConnectorClient } from "../../src/mcp/client";
import { createRuntime } from "../../src/runtime";
import { writeSessionFile, readSessionFile } from "../../src/util/session";
import { FakeExtension, TINY_PNG_BASE64 } from "../helpers/fake-extension";
import type { CliOptions } from "../../src/cli";

/**
 * The path taken when a connector is already running for another MCP client.
 * Everything here goes over real HTTP rather than in-process calls.
 */

let connector: Connector;
let extension: FakeExtension | null = null;
let stateDir: string;
let screenshotDir: string;

const baseOptions: CliOptions = {
  showVersion: false,
  showHelp: false,
  doctor: false,
  redact: true,
  standalone: false,
};

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-attach-state-"));
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-attach-shots-"));
  process.env["BROWSER_TOOLS_STATE_DIR"] = stateDir;

  connector = await createConnector({
    port: 0,
    screenshotDir,
    requestTimeoutMs: 3_000,
    // Hermetic: audit targets are resolved before the runner is called.
    auditLookup: async () => ["93.184.215.14"],
    auditRunner: async ({ url, category }) => ({
      category,
      metadata: { url, timestamp: "2026-07-30T00:00:00.000Z", device: "desktop", lighthouseVersion: "13.4.1" },
      score: 91,
      summary: { failed: 1, passed: 2, manual: 0, informative: 0, notApplicable: 0 },
      issues: [{ id: "meta-description", title: "No meta description", description: "", score: 0, weight: 5, impact: "critical" }],
    }),
  });
});

afterEach(async () => {
  await extension?.close();
  extension = null;
  await connector?.close();
  delete process.env["BROWSER_TOOLS_STATE_DIR"];
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

async function connectExtension(options: Record<string, unknown> = {}) {
  const ext = new FakeExtension({ port: connector.port, ...(options as any) });
  await ext.connect();
  await ext.waitForWelcome();
  extension = ext;
  return ext;
}

function publishSession() {
  writeSessionFile({
    port: connector.port,
    token: connector.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: "2.0.0",
  });
}

describe("HttpConnectorClient against a live connector", () => {
  const makeClient = () =>
    new HttpConnectorClient({
      baseUrl: `http://127.0.0.1:${connector.port}`,
      token: connector.token,
    });

  it("reads console and network telemetry over HTTP", async () => {
    const ext = await connectExtension();
    ext.send({
      type: "console",
      entries: [
        { type: "console-log", level: "log", message: "OVER-HTTP", timestamp: Date.now() },
        { type: "console-error", level: "error", message: "HTTP-BOOM", timestamp: Date.now() },
      ],
    });
    ext.send({
      type: "network",
      entries: [{ url: "https://api.test/x", method: "GET", status: 502, timestamp: Date.now() }],
    });

    const client = makeClient();

    await vi.waitFor(async () => {
      const result = await client.console({});
      expect(result.total).toBe(2);
    });

    expect((await client.console({ errorsOnly: true })).entries[0]!.message).toBe("HTTP-BOOM");
    expect((await client.console({ keywords: ["OVER-HTTP"] })).returned).toBe(1);
    expect((await client.network({ errorsOnly: true })).entries[0]!.status).toBe(502);
  });

  it("passes paging parameters through the query string", async () => {
    const ext = await connectExtension();
    ext.send({
      type: "console",
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: "console-log",
        message: `http-line-${i}`,
        timestamp: Date.now() + i,
      })),
    });

    const client = makeClient();
    await vi.waitFor(async () => {
      expect((await client.console({})).total).toBe(12);
    });

    const page = await client.console({ limit: 4 });
    expect(page.returned).toBe(4);
    expect(page.total).toBe(12);
    expect(page.entries.at(-1)!.message).toBe("http-line-11");
  });

  it("reads page state and the selected element over HTTP", async () => {
    const ext = await connectExtension();
    ext.send({ type: "page", url: "https://example.com/http", tabId: 9 });
    ext.send({ type: "selected-element", element: { tagName: "SECTION" } });

    const client = makeClient();
    await vi.waitFor(async () => {
      expect((await client.page()).url).toBe("https://example.com/http");
    });

    expect((await client.selectedElement()) as any).toMatchObject({ tagName: "SECTION" });
    expect((await client.status()).extensionConnected).toBe(true);
  });

  it("captures a screenshot over HTTP", async () => {
    await connectExtension();
    const client = makeClient();

    const result = await client.screenshot({});
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.data).toContain(TINY_PNG_BASE64.slice(0, 20));
  });

  it("refreshes, reads storage and wipes over HTTP", async () => {
    const ext = await connectExtension({
      onStorage: () => ({ ok: true, storage: { localStorage: { k: "v" } } }),
    });
    const client = makeClient();

    await client.refresh();
    expect(ext.received.some((m) => m.type === "refresh-tab")).toBe(true);

    expect(await client.storage(["localStorage"])).toMatchObject({ localStorage: { k: "v" } });

    ext.send({
      type: "console",
      entries: [{ type: "console-log", message: "to-wipe", timestamp: Date.now() }],
    });
    await vi.waitFor(async () => expect((await client.console({})).total).toBe(1));
    await client.wipe();
    expect((await client.console({})).total).toBe(0);
  });

  it("runs an audit over HTTP", async () => {
    const client = makeClient();
    const report = await client.audit("seo", { url: "https://example.com" });

    expect(report.category).toBe("seo");
    expect(report.score).toBe(91);
    expect(report.issues[0]!.id).toBe("meta-description");
  });

  it("audits the named tab over HTTP, not the current one", async () => {
    // The route used to drop tabId, so an attached client asking for one tab
    // got the current page audited instead.
    const first = new FakeExtension({ port: connector.port, tabId: 1 });
    const second = new FakeExtension({ port: connector.port, tabId: 2 });
    try {
      for (const [ext, tabId, url] of [
        [first, 1, "https://one.example/"],
        [second, 2, "https://two.example/"],
      ] as const) {
        await ext.connect();
        await ext.waitForWelcome();
        ext.send({ type: "page", url, tabId });
      }
      const urls = () => connector.listTabs().map((t) => t.url).sort();
      await vi.waitFor(() => expect(urls()).toEqual(["https://one.example/", "https://two.example/"]));

      const client = makeClient();
      expect((await client.audit("seo", { tabId: 2 })).metadata.url).toBe("https://two.example/");
      expect((await client.audit("seo", { tabId: 1 })).metadata.url).toBe("https://one.example/");
      await expect(client.audit("seo", { tabId: 99 })).rejects.toThrow(/Unknown tab 99/);

      // A tab that has not said where it is gets an error, not another tab's page.
      const quiet = new FakeExtension({ port: connector.port, tabId: 3 });
      try {
        await quiet.connect();
        await quiet.waitForWelcome();
        await vi.waitFor(() => expect(connector.listTabs().map((t) => t.tabId)).toContain(3));
        await expect(client.audit("seo", { tabId: 3 })).rejects.toThrow(/Tab 3 has not reported its page/);
      } finally {
        await quiet.close();
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("surfaces connector errors as thrown errors, not silent empties", async () => {
    const client = makeClient();
    // No extension connected, so a screenshot cannot succeed.
    await expect(client.screenshot({})).rejects.toThrow(/extension/i);
  });

  it("rejects a wrong token", async () => {
    const client = new HttpConnectorClient({
      baseUrl: `http://127.0.0.1:${connector.port}`,
      token: "wrong-token",
    });
    await expect(client.console({})).rejects.toThrow(/authorization/i);
  });
});

describe("runtime attach behaviour", () => {
  it("attaches to a connector that is already running", async () => {
    publishSession();

    const runtime = await createRuntime({ ...baseOptions });

    expect(runtime.connector).toBeNull();
    expect(runtime.description).toContain(String(connector.port));
    expect(runtime.degradedReason).toBeUndefined();

    const ext = await connectExtension();
    ext.send({
      type: "console",
      entries: [{ type: "console-log", message: "SHARED", timestamp: Date.now() }],
    });

    await vi.waitFor(async () => {
      expect((await runtime.client.console({})).total).toBe(1);
    });

    // Closing the attached runtime must not stop the connector someone else owns.
    await runtime.close();
    expect(connector.hasExtension()).toBe(true);
  });

  it("says so when audit flags cannot apply because it attached", async () => {
    publishSession();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const runtime = await createRuntime({ ...baseOptions, auditAllowedOrigins: ["http://localhost:4000"] });
      expect(runtime.connector).toBeNull();
      await runtime.close();
      const written = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(written).toMatch(/WARN .*--audit-allow-origin and --audit-allow-private-network are ignored/);
    } finally {
      stderr.mockRestore();
    }
  });

  it("starts its own connector when the session file points at a dead port", async () => {
    writeSessionFile({
      port: 1,
      token: "stale-token",
      pid: 999999,
      startedAt: new Date().toISOString(),
      version: "2.0.0",
    });

    const started = Date.now();
    const runtime = await createRuntime({ ...baseOptions, port: 0, screenshotDir });

    // Must not hang probing a dead address.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(runtime.connector).not.toBeNull();
    expect(runtime.description).toContain("embedded");

    await runtime.close();
  });

  it("attaches to an explicit --connect url with a token", async () => {
    const runtime = await createRuntime({
      ...baseOptions,
      connectUrl: `http://127.0.0.1:${connector.port}`,
      token: connector.token,
    });

    expect(runtime.connector).toBeNull();
    expect((await runtime.client.status()).version).toBeTruthy();
    await runtime.close();
  });

  it("refuses --connect without a token", async () => {
    await expect(
      createRuntime({ ...baseOptions, connectUrl: `http://127.0.0.1:${connector.port}` })
    ).rejects.toThrow(/token/i);
  });

  it("writes a session file when it starts its own connector, and clears it on close", async () => {
    const runtime = await createRuntime({ ...baseOptions, port: 0, screenshotDir });

    const session = readSessionFile();
    expect(session?.port).toBe(runtime.connector!.port);
    expect(session?.token).toBe(runtime.connector!.token);

    await runtime.close();
    expect(readSessionFile()).toBeNull();
  });

  it("stores the session file with owner-only permissions", async () => {
    const runtime = await createRuntime({ ...baseOptions, port: 0, screenshotDir });

    // The file holds an auth token, so it must not be world-readable.
    const mode = fs.statSync(path.join(stateDir, "session.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    await runtime.close();
  });

  it("still produces a usable client when the connector cannot start", async () => {
    // Port 1 is privileged, so binding fails.
    const runtime = await createRuntime({ ...baseOptions, port: 1 });

    expect(runtime.degradedReason).toBeTruthy();
    // Tool calls must explain the problem rather than hang or return empties.
    await expect(runtime.client.console({})).rejects.toThrow(/not available/i);

    await runtime.close();
  });
});
