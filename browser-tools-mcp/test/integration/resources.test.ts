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

/**
 * Large payloads are exposed as MCP resources and referenced from tool results
 * with resource_link, rather than inlined.
 *
 * A full HAR or a complete console history is exactly what you want when a
 * request needs proper examination, and exactly what should never be pushed
 * into a context window unasked.
 */

let connector: Connector;
let extension: FakeExtension | null = null;
let client: Client;
let closeServer: (() => Promise<void>) | null = null;
let screenshotDir: string;

beforeEach(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-res-"));
  connector = await createConnector({
    port: 0,
    screenshotDir,
    requestTimeoutMs: 3_000,
    // Hermetic: audit targets are resolved before the runner is called.
    auditLookup: async () => ["93.184.215.14"],
    auditRunner: async ({ url, category }, hooks) => {
      // Hand back a raw result so the connector has a full report to persist.
      hooks?.onRawResult?.({ lighthouseVersion: "13.4.1", requestedUrl: url, huge: "x".repeat(5000) });
      return {
        category,
        metadata: { url, timestamp: "2026-08-04T00:00:00.000Z", device: "desktop", lighthouseVersion: "13.4.1" },
        score: 88,
        summary: { failed: 1, passed: 1, manual: 0, informative: 0, notApplicable: 0 },
        issues: [{ id: "x", title: "X", description: "", score: 0, weight: 1, impact: "critical" }],
      };
    },
  });

  const { server } = createMcpServer({ client: new InProcessConnectorClient(connector) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "resource-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeServer = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await closeServer?.();
  closeServer = null;
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

async function seedTelemetry(count = 150) {
  // Retention defaults to 50 entries per tab; the point here is a resource that
  // exceeds the per-call budget, not one that exceeds retention.
  connector.store.updateSettings({ logLimit: 500 });
  const ext = await connectExtension();
  ext.send({
    type: "console",
    entries: Array.from({ length: count }, (_, i) => ({
      type: "console-log",
      message: `line-${i} ${"z".repeat(400)}`,
      timestamp: Date.now() + i,
    })),
  });
  ext.send({
    type: "network",
    entries: [
      {
        url: "https://api.test/ok?page=2",
        method: "GET",
        status: 200,
        timestamp: Date.now(),
        durationMs: 12,
        responseBody: '{"ok":true}',
      },
      { url: "https://api.test/bad", method: "POST", status: 500, timestamp: Date.now() },
    ],
  });
  await vi.waitFor(() => {
    expect(connector.store.queryConsole({}).total).toBe(count);
    expect(connector.store.queryNetwork({}).total).toBe(2);
  });
  return ext;
}

describe("resource discovery", () => {
  it("advertises the resources capability", async () => {
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.resources).toBeDefined();
  });

  it("lists the resource templates", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const uris = resourceTemplates.map((t) => t.uriTemplate);

    expect(uris).toEqual(
      expect.arrayContaining([
        expect.stringContaining("browser-tools://console/"),
        expect.stringContaining("browser-tools://network/"),
        expect.stringContaining("browser-tools://har/"),
        expect.stringContaining("browser-tools://screenshot/"),
      ])
    );
  });

  it("gives every template a name and description", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.length).toBeGreaterThan(2);
    for (const template of resourceTemplates) {
      expect(template.name, template.uriTemplate).toBeTruthy();
      expect(template.description, template.uriTemplate).toBeTruthy();
    }
  });
});

describe("reading telemetry resources", () => {
  it("returns the complete console history, past the per-call budget", async () => {
    await seedTelemetry(150);

    // The tool result is clipped to the query budget.
    const tool: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });
    expect(tool.structuredContent.truncated).toBe(true);
    expect(tool.structuredContent.returned).toBeLessThan(150);

    // The resource is not.
    const resource = await client.readResource({ uri: "browser-tools://console/all" });
    const payload = JSON.parse((resource.contents[0] as any).text);

    expect(payload.entries).toHaveLength(150);
    expect((resource.contents[0] as any).mimeType).toBe("application/json");
  });

  it("returns the complete network history", async () => {
    await seedTelemetry();

    const resource = await client.readResource({ uri: "browser-tools://network/all" });
    const payload = JSON.parse((resource.contents[0] as any).text);

    expect(payload.entries).toHaveLength(2);
    expect(payload.entries.some((e: any) => e.url.endsWith("/bad"))).toBe(true);
  });

  it("returns network activity as a HAR", async () => {
    await seedTelemetry();

    const resource = await client.readResource({ uri: "browser-tools://har/all" });
    const har = JSON.parse((resource.contents[0] as any).text);

    expect(har.log.version).toBe("1.2");
    expect(har.log.entries).toHaveLength(2);
    expect(har.log.entries[0].request.queryString).toEqual([{ name: "page", value: "2" }]);
  });

  it("scopes a resource to one tab", async () => {
    await seedTelemetry();

    const scoped = await client.readResource({ uri: "browser-tools://console/1" });
    const payload = JSON.parse((scoped.contents[0] as any).text);

    expect(payload.tabId).toBe(1);
    expect(payload.entries.length).toBeGreaterThan(0);
  });

  it("reports an unknown resource rather than returning empty data", async () => {
    await expect(
      client.readResource({ uri: "browser-tools://nonsense/all" })
    ).rejects.toThrow();
  });
});

describe("screenshot resources", () => {
  it("serves a captured screenshot as a blob", async () => {
    await connectExtension();
    const shot: any = await client.callTool({ name: "takeScreenshot", arguments: {} });
    const name = shot.structuredContent.name;

    const resource = await client.readResource({ uri: `browser-tools://screenshot/${name}` });
    const contents = resource.contents[0] as any;

    expect(contents.mimeType).toBe("image/png");
    expect(Buffer.from(contents.blob, "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
  });

  it("refuses a screenshot name that escapes the directory", async () => {
    await expect(
      client.readResource({ uri: "browser-tools://screenshot/..%2F..%2Fetc%2Fpasswd" })
    ).rejects.toThrow();
  });
});

describe("resource links on tool results", () => {
  it("links to the screenshot it just captured", async () => {
    await connectExtension();

    const result: any = await client.callTool({ name: "takeScreenshot", arguments: {} });
    const link = result.content.find((c: any) => c.type === "resource_link");

    expect(link).toBeTruthy();
    expect(link.uri).toBe(`browser-tools://screenshot/${result.structuredContent.name}`);
    expect(link.mimeType).toBe("image/png");
  });

  // The case the link matters most for: the image is too large to inline, so
  // the link is the only way for a client to get at it.
  it("links to an oversized screenshot that could not be inlined", async () => {
    connector.store.updateSettings({ screenshotMaxBytes: 50_000 });
    await connectExtension({
      onScreenshot: () => ({ ok: true, data: `data:image/png;base64,${"A".repeat(400_000)}` }),
    });

    const result: any = await client.callTool({ name: "takeScreenshot", arguments: {} });

    expect(result.content.some((c: any) => c.type === "image")).toBe(false);
    expect(result.content.some((c: any) => c.type === "resource_link")).toBe(true);
  });

  it("links to the full history when a log read was truncated", async () => {
    await seedTelemetry(150);

    const result: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });
    expect(result.structuredContent.truncated).toBe(true);

    const link = result.content.find((c: any) => c.type === "resource_link");
    expect(link?.uri).toContain("browser-tools://console/");
  });

  it("does not add a link when the whole result already fits", async () => {
    const ext = await connectExtension();
    ext.send({
      type: "console",
      entries: [{ type: "console-log", message: "just one", timestamp: Date.now() }],
    });
    await vi.waitFor(() => expect(connector.store.queryConsole({}).total).toBe(1));

    const result: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });

    expect(result.structuredContent.truncated).toBe(false);
    expect(result.content.some((c: any) => c.type === "resource_link")).toBe(false);
  });

  it("always offers the HAR alongside network results", async () => {
    await seedTelemetry();

    const result: any = await client.callTool({ name: "getNetworkLogs", arguments: {} });
    const har = result.content.find(
      (c: any) => c.type === "resource_link" && c.uri.includes("har")
    );

    expect(har).toBeTruthy();
    expect(har.mimeType).toBe("application/json");
  });

  it("links to the full lighthouse report", async () => {
    const result: any = await client.callTool({ name: "runSEOAudit", arguments: { url: "https://example.com" } });

    expect(result.isError).toBeFalsy();
    const link = result.content.find((c: any) => c.type === "resource_link");
    expect(link?.uri).toContain("browser-tools://audit/");

    // And the linked report is the unabridged one.
    const resource = await client.readResource({ uri: link.uri });
    const raw = JSON.parse((resource.contents[0] as any).text);
    expect(raw.lighthouseVersion).toBe("13.4.1");
    expect(raw.huge.length).toBe(5000);
  });
});

describe("artifact retention", () => {
  it("keeps only the most recent audit reports", async () => {
    for (let i = 0; i < 25; i++) {
      await client.callTool({
        name: "runSEOAudit",
        arguments: { url: `https://example.com/${i}` },
      });
    }

    // Raw Lighthouse results are megabytes each; without a cap they would grow
    // without bound on disk.
    const stored = fs.readdirSync(path.join(screenshotDir, "audits"));
    expect(stored.length).toBeLessThanOrEqual(20);
    expect(stored.length).toBeGreaterThan(0);
  });

  it("still serves the newest report after pruning", async () => {
    for (let i = 0; i < 22; i++) {
      await client.callTool({
        name: "runSEOAudit",
        arguments: { url: `https://example.com/${i}` },
      });
    }
    const last: any = await client.callTool({
      name: "runSEOAudit",
      arguments: { url: "https://example.com/final" },
    });

    const link = last.content.find((c: any) => c.type === "resource_link");
    const resource = await client.readResource({ uri: link.uri });
    const raw = JSON.parse((resource.contents[0] as any).text);
    expect(raw.requestedUrl).toBe("https://example.com/final");
  });
});
