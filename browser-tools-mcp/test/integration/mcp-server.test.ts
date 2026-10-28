import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector, type Connector } from "../../src/connector/connector";
import { InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { FakeExtension, TINY_PNG_BASE64 } from "../helpers/fake-extension";

let connector: Connector;
let extension: FakeExtension | null = null;
let client: Client;
let screenshotDir: string;
let closeServer: () => Promise<void>;

async function startServer(options: Parameters<typeof createMcpServer>[0] extends never ? never : any = {}) {
  const { server } = createMcpServer({
    client: new InProcessConnectorClient(connector),
    ...options,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeServer = async () => {
    await client.close();
    await server.close();
  };
}

beforeEach(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-mcp-"));
  connector = await createConnector({ port: 0, screenshotDir, requestTimeoutMs: 3_000 });
});

afterEach(async () => {
  await closeServer?.();
  await extension?.close();
  extension = null;
  await connector?.close();
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

async function connectExtension(options: Record<string, unknown> = {}) {
  const ext = new FakeExtension({ port: connector.port, ...(options as any) });
  await ext.connect();
  await ext.waitForWelcome();
  extension = ext;
  return ext;
}

describe("tool registration", () => {
  beforeEach(() => startServer());

  it("exposes the expected tool set", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        "getBrowserStorage",
        "getConnectionStatus",
        "getConsoleErrors",
        "getConsoleLogs",
        "getNetworkErrors",
        "getNetworkLogs",
        "getPageInfo",
        "getSelectedElement",
        "listBrowserTabs",
        "listTabs",
        "navigateBrowser",
        "navigateTab",
        "readTab",
        "snapshotTab",
        "softClick",
        "softType",
        "actOnRef",
        "refreshBrowser",
        "runAccessibilityAudit",
        "runBestPracticesAudit",
        "runPerformanceAudit",
        "runSEOAudit",
        "takeScreenshot",
        "wipeLogs",
      ].sort()
    );
  });

  it("gives every tool a description and a human title", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.annotations?.title, `${tool.name} needs a title`).toBeTruthy();
    }
  });

  it("marks read-only tools as read-only", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of [
      "getConsoleLogs",
      "getConsoleErrors",
      "getNetworkLogs",
      "getNetworkErrors",
      "getSelectedElement",
      "getPageInfo",
      "getConnectionStatus",
      "listTabs",
      "readTab",
      "snapshotTab",
    ]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
  });

  it("marks state-changing tools as not read-only", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get("navigateTab")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("softClick")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("softType")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("actOnRef")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("wipeLogs")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("wipeLogs")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("refreshBrowser")?.annotations?.readOnlyHint).toBe(false);
    // A screenshot writes a file but destroys nothing.
    expect(byName.get("takeScreenshot")?.annotations?.destructiveHint).toBe(false);
  });

  it("declares input schemas for the tools that take parameters", async () => {
    const { tools } = await client.listTools();
    const consoleTool = tools.find((t) => t.name === "getConsoleLogs")!;
    const properties = (consoleTool.inputSchema as any).properties ?? {};

    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["keywords", "limit", "offset"])
    );
  });

  it("declares output schemas so clients get structured results", async () => {
    const { tools } = await client.listTools();
    for (const name of ["getConsoleLogs", "getNetworkLogs", "getPageInfo"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.outputSchema, `${name} should declare an output schema`).toBeTruthy();
    }
  });

  it("registers the guidance prompts", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(["debuggerMode", "auditMode", "nextjsSeoAudit"])
    );
  });

  it("returns prompt content when asked", async () => {
    const result = await client.getPrompt({ name: "debuggerMode", arguments: {} });
    expect(result.messages.length).toBeGreaterThan(0);
    const text = JSON.stringify(result.messages);
    expect(text.length).toBeGreaterThan(100);
  });
});

describe("reading telemetry", () => {
  beforeEach(async () => {
    await startServer();
    await connectExtension();
    extension!.send({
      type: "console",
      entries: [
        { type: "console-log", level: "log", message: "MARKER-ONE", timestamp: Date.now() },
        { type: "console-error", level: "error", message: "KABOOM", timestamp: Date.now() },
      ],
    });
    extension!.send({
      type: "network",
      entries: [
        { url: "https://api.test/ok", method: "GET", status: 200, timestamp: Date.now() },
        { url: "https://api.test/nope", method: "GET", status: 503, timestamp: Date.now() },
      ],
    });
    await vi.waitFor(async () => {
      const result: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });
      expect(result.structuredContent.total).toBe(2);
    });
  });

  it("returns structured console output", async () => {
    const result: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.entries).toHaveLength(2);
    expect(result.structuredContent.entries[0].message).toBe("MARKER-ONE");
    // A text rendering accompanies the structured payload for clients that
    // only display content blocks.
    expect(result.content[0].type).toBe("text");
  });

  it("filters console output by keyword", async () => {
    const result: any = await client.callTool({
      name: "getConsoleLogs",
      arguments: { keywords: ["KABOOM"] },
    });
    expect(result.structuredContent.entries).toHaveLength(1);
  });

  it("returns only errors from getConsoleErrors", async () => {
    const result: any = await client.callTool({ name: "getConsoleErrors", arguments: {} });
    expect(result.structuredContent.entries).toHaveLength(1);
    expect(result.structuredContent.entries[0].message).toBe("KABOOM");
  });

  it("separates network errors from successful requests", async () => {
    const all: any = await client.callTool({ name: "getNetworkLogs", arguments: {} });
    const errors: any = await client.callTool({ name: "getNetworkErrors", arguments: {} });

    expect(all.structuredContent.total).toBe(2);
    expect(errors.structuredContent.entries).toHaveLength(1);
    expect(errors.structuredContent.entries[0].status).toBe(503);
  });

  // Regression: the old getNetworkErrors always set isError, so clients treated
  // a successful "no errors found" reply as a tool failure.
  it("does not flag a successful getNetworkErrors call as an error", async () => {
    const result: any = await client.callTool({ name: "getNetworkErrors", arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it("reports page info and connection status", async () => {
    extension!.send({ type: "page", url: "https://example.com/page", tabId: 3 });

    await vi.waitFor(async () => {
      const result: any = await client.callTool({ name: "getPageInfo", arguments: {} });
      expect(result.structuredContent.url).toBe("https://example.com/page");
    });

    const status: any = await client.callTool({ name: "getConnectionStatus", arguments: {} });
    expect(status.structuredContent.extensionConnected).toBe(true);
  });

  it("wipes logs", async () => {
    await client.callTool({ name: "wipeLogs", arguments: {} });
    const result: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });
    expect(result.structuredContent.total).toBe(0);
  });
});

describe("screenshots", () => {
  beforeEach(() => startServer());

  it("returns the image to the model, not just a file path", async () => {
    await connectExtension();
    const result: any = await client.callTool({ name: "takeScreenshot", arguments: {} });

    const image = result.content.find((c: any) => c.type === "image");
    expect(image).toBeTruthy();
    expect(image.mimeType).toBe("image/png");
    expect(image.data).toContain(TINY_PNG_BASE64.slice(0, 20));
    expect(result.structuredContent.path).toContain(screenshotDir);
  });

  it("reports a helpful error when the extension is not connected", async () => {
    const result: any = await client.callTool({ name: "takeScreenshot", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/extension/i);
  });
});

describe("browser control and storage", () => {
  beforeEach(() => startServer());

  it("refreshes the browser tab", async () => {
    const ext = await connectExtension();
    const result: any = await client.callTool({ name: "refreshBrowser", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(ext.received.some((m) => m.type === "refresh-tab")).toBe(true);
  });

  it("refuses to return storage values unless explicitly unlocked", async () => {
    await connectExtension({
      onStorage: () => ({
        ok: true,
        storage: { localStorage: { token: "sensitive" }, sessionStorage: {}, cookies: [] },
      }),
    });

    const result: any = await client.callTool({
      name: "getBrowserStorage",
      arguments: { kinds: ["localStorage"] },
    });

    // Default posture: keys are listed, values are withheld.
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(JSON.stringify(result)).toContain("token");
  });

  it("returns storage values when the user opts in", async () => {
    await connectExtension({
      onStorage: () => ({
        ok: true,
        storage: { localStorage: { theme: "dark" }, sessionStorage: {}, cookies: [] },
      }),
    });

    const result: any = await client.callTool({
      name: "getBrowserStorage",
      arguments: { kinds: ["localStorage"], includeValues: true },
    });

    expect(JSON.stringify(result)).toContain("dark");
  });
});

describe("tool filtering", () => {
  it("can expose only a chosen subset of tools", async () => {
    await startServer({ enabledTools: ["getConsoleLogs", "takeScreenshot"] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["getConsoleLogs", "takeScreenshot"]);
  });

  it("can exclude specific tools", async () => {
    await startServer({ disabledTools: ["wipeLogs", "refreshBrowser"] });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("wipeLogs");
    expect(names).not.toContain("refreshBrowser");
    expect(names).toContain("getConsoleLogs");
  });

  it("ignores unknown tool names in the filter rather than failing to start", async () => {
    await startServer({ enabledTools: ["getConsoleLogs", "noSuchTool"] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["getConsoleLogs"]);
  });
});
