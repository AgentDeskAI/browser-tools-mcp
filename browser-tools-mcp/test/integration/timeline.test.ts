import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector, type Connector } from "../../src/connector/connector";
import { InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { invokeTool } from "../../src/mcp/tool-invoke";
import { FakeExtension } from "../helpers/fake-extension";

let connector: Connector;
let extension: FakeExtension | null = null;
let devtools: FakeExtension | null = null;
let client: Client;
let screenshotDir: string;
let closeServer: () => Promise<void>;

const ORIGIN = "https://billing.example:443";
const SECRET = "super-secret-token";

async function startServer() {
  const { server } = createMcpServer({ client: new InProcessConnectorClient(connector) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeServer = async () => {
    await client.close();
    await server.close();
  };
}

beforeEach(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-timeline-mcp-"));
  connector = await createConnector({ port: 0, screenshotDir, requestTimeoutMs: 3_000 });
  await startServer();
  extension = new FakeExtension({ port: connector.port, role: "worker" });
  await extension.connect();
  await extension.waitForWelcome();
});

afterEach(async () => {
  await closeServer?.();
  await extension?.close();
  await devtools?.close();
  extension = null;
  devtools = null;
  await connector?.close();
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

function auth() {
  return `Bearer ${connector.token}`;
}

async function enableBillingTab() {
  const targets = [
    {
      kind: "tab",
      chromeTabId: 4,
      origin: ORIGIN,
      url: "https://billing.example/pay",
      title: "Billing",
      enabledAt: Date.now(),
    },
  ];
  await vi.waitFor(async () => {
    extension!.send({ type: "timeline-targets", targets });
    const listed: any = await client.callTool({ name: "listTracked", arguments: {} });
    const body = JSON.parse(listed.content[0].text);
    expect(body.targets).toHaveLength(1);
  });
}

describe("opt-in timeline", () => {
  it("stays empty until the user enables a tab, then answers by time", async () => {
    const before: any = await client.callTool({
      name: "getTimeline",
      arguments: { chromeTabId: 4, lastMinutes: 30 },
    });
    const empty = JSON.parse(before.content[0].text);
    expect(before.isError).toBeUndefined();
    expect(empty.tracked).toBe(false);
    expect(empty.reason).toBe("not-enabled");
    expect(empty.console).toEqual([]);
    expect(empty.network).toEqual([]);

    await enableBillingTab();
    const now = Date.now();
    extension!.send({
      type: "timeline-event",
      event: {
        kind: "console",
        chromeTabId: 4,
        origin: ORIGIN,
        url: "https://billing.example/pay",
        level: "error",
        message: "invoice failed",
        timestamp: now - 2 * 60_000,
      },
    });
    extension!.send({
      type: "timeline-event",
      event: {
        kind: "network",
        chromeTabId: 4,
        origin: ORIGIN,
        url: "https://billing.example/api/pay",
        method: "POST",
        status: 500,
        timestamp: now - 2 * 60_000,
        requestHeaders: {
          Authorization: `Bearer ${SECRET}`,
          Cookie: "session=abc123secret",
          "Content-Type": "application/json",
        },
      },
    });

    await vi.waitFor(async () => {
      const result: any = await client.callTool({
        name: "getTimeline",
        arguments: { chromeTabId: 4, lastMinutes: 10 },
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.reason).toBe("ok");
      expect(body.console.map((entry: { message: string }) => entry.message)).toEqual(["invoice failed"]);
    });

    const result: any = await client.callTool({
      name: "getTimeline",
      arguments: { origin: "https://billing.example", lastMinutes: 10 },
    });
    const body = JSON.parse(result.content[0].text);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("abc123secret");
    expect(body.network[0].requestHeaders["Content-Type"]).toBe("application/json");
    expect(body.network[0].status).toBe(500);

    const other: any = await client.callTool({
      name: "getTimeline",
      arguments: { chromeTabId: 9, lastMinutes: 10 },
    });
    const otherBody = JSON.parse(other.content[0].text);
    expect(otherBody.reason).toBe("not-enabled");
    expect(otherBody.console).toEqual([]);
    expect(JSON.stringify(otherBody)).not.toContain("invoice failed");

    const outside: any = await client.callTool({
      name: "getTimeline",
      arguments: {
        chromeTabId: 4,
        from: new Date(now - 10 * 24 * 60 * 60_000).toISOString(),
        to: new Date(now - 9 * 24 * 60 * 60_000).toISOString(),
      },
    });
    const outsideBody = JSON.parse(outside.content[0].text);
    expect(outsideBody.reason).toBe("outside-window");
    expect(outsideBody.console).toEqual([]);
    expect(outsideBody.network).toEqual([]);
    expect(JSON.stringify(outsideBody)).not.toContain("invoice failed");
  });

  it("does not treat the DevTools buffer as the timeline", async () => {
    devtools = new FakeExtension({ port: connector.port, tabId: 4 });
    await devtools.connect();
    await devtools.waitForWelcome();
    devtools.send({
      type: "console",
      entries: [{ level: "error", message: "devtools only", timestamp: Date.now() }],
    });
    devtools.send({
      type: "timeline-event",
      event: {
        kind: "console",
        chromeTabId: 4,
        origin: ORIGIN,
        message: "forged from devtools",
        timestamp: Date.now(),
      },
    });

    await vi.waitFor(async () => {
      const logs: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });
      expect(JSON.parse(logs.content[0].text).entries[0].message).toBe("devtools only");
    });

    const timeline: any = await client.callTool({
      name: "getTimeline",
      arguments: { chromeTabId: 4, lastMinutes: 30 },
    });
    const body = JSON.parse(timeline.content[0].text);
    expect(body.reason).toBe("not-enabled");
    expect(JSON.stringify(body)).not.toContain("devtools only");
    expect(JSON.stringify(body)).not.toContain("forged from devtools");
  });

  it("serves the same log over the local API and the CLI invoke path", async () => {
    await enableBillingTab();
    extension!.send({
      type: "timeline-event",
      event: {
        kind: "console",
        chromeTabId: 4,
        origin: ORIGIN,
        url: "https://billing.example/pay",
        level: "error",
        message: "invoice failed",
        timestamp: Date.now(),
      },
    });

    await vi.waitFor(async () => {
      const res = await request(connector.app)
        .get("/api/timeline/logs")
        .query({ chromeTabId: 4, lastMinutes: 15 })
        .set("Authorization", auth());
      expect(res.status).toBe(200);
      expect(res.body.console[0].message).toBe("invoice failed");
    });

    const cli = await invokeTool("getTimeline", new InProcessConnectorClient(connector), {
      chromeTabId: 4,
      lastMinutes: 15,
    });
    expect(cli.isError).toBeUndefined();
    expect(cli.structuredContent?.["reason"]).toBe("ok");

    const missing = await request(connector.app)
      .get("/api/timeline/logs")
      .set("Authorization", auth());
    expect(missing.status).toBe(400);

    const hidden = await createConnector({
      port: 0,
      screenshotDir,
      requestTimeoutMs: 3_000,
      disabledTools: ["getTimeline"],
    });
    try {
      const refused = await request(hidden.app)
        .get("/api/timeline/logs")
        .query({ chromeTabId: 4 })
        .set("Authorization", `Bearer ${hidden.token}`);
      expect(refused.status).toBe(403);
    } finally {
      await hidden.close();
    }
  });
});
