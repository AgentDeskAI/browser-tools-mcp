import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector, type Connector } from "../../src/connector/connector";
import { HttpConnectorClient, InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { invokeTool } from "../../src/mcp/tool-invoke";
import { RESTRICTED_PAGE_MESSAGE, RestrictedPageError } from "../../src/restricted-page";
import { FakeExtension } from "../helpers/fake-extension";

function payloadOf(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  expect(result.isError).toBe(true);
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  expect(text).toContain(RESTRICTED_PAGE_MESSAGE);
  return JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
}

describe("restricted page navigation", () => {
  let connector: Connector | undefined;
  let devtools: FakeExtension | undefined;
  let worker: FakeExtension | undefined;

  afterEach(async () => {
    await devtools?.close();
    await worker?.close();
    await connector?.close();
    devtools = undefined;
    worker = undefined;
  });

  async function start(allowInput = true) {
    const screenshotDir = path.join(os.tmpdir(), `bt-restricted-${Date.now()}`);
    connector = await createConnector({ port: 0, screenshotDir, allowInput });
    return connector;
  }

  it("refuses chrome://, DevTools, view-source, the Web Store, and extension pages before navigating", async () => {
    const current = await start();
    const urls = [
      ["chrome://settings", "chrome"],
      ["devtools://devtools/", "devtools"],
      ["view-source:https://example.com/", "view-source"],
      ["https://chromewebstore.google.com/detail/foo", "web-store"],
      ["https://chrome.google.com/webstore/category/extensions", "web-store"],
      ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html", "extension"],
      ["edge://settings", "browser"],
    ] as const;

    for (const [url, kind] of urls) {
      await expect(current.navigateTab({ url, tabId: 1 }), url).rejects.toBeInstanceOf(RestrictedPageError);
      try {
        await current.navigateTab({ url, tabId: 1 });
      } catch (error) {
        expect(error).toBeInstanceOf(RestrictedPageError);
        expect((error as RestrictedPageError).toJSON()).toMatchObject({
          access: "metadata-only",
          message: RESTRICTED_PAGE_MESSAGE,
          scriptable: false,
          kind,
          navigated: false,
        });
      }
    }
  });

  it("returns the same JSON from the local API and the HTTP client", async () => {
    const current = await start();
    const response = await request(current.app)
      .post("/api/navigate")
      .set("Authorization", `Bearer ${current.token}`)
      .send({ url: "chrome://extensions" });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: "RESTRICTED_PAGE",
      access: "metadata-only",
      message: RESTRICTED_PAGE_MESSAGE,
      scriptable: false,
      kind: "chrome",
      navigated: false,
    });

    const http = new HttpConnectorClient({
      baseUrl: `http://127.0.0.1:${current.port}`,
      token: current.token,
    });
    await expect(http.navigate({ url: "view-source:http://localhost/" })).rejects.toMatchObject({
      name: "RestrictedPageError",
      report: { kind: "view-source", message: RESTRICTED_PAGE_MESSAGE },
    });
  });

  it("loads an http PDF and then reports that the viewer cannot be scripted", async () => {
    const current = await start();
    devtools = new FakeExtension({ port: current.port, tabId: 7 });
    let probePopup = false;
    worker = new FakeExtension({
      port: current.port,
      role: "worker",
      onCapabilityProbe: () => ({
        popupEnabled: probePopup,
        panelEnabled: false,
        liveUrl: "http://127.0.0.1:3000/",
        excludeOrigins: [],
      }),
      onNavigate: async (msg) => ({ ok: true, finalUrl: msg.url, wasDiscarded: true }),
    });
    await devtools.connect();
    await worker.connect();
    worker.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;
    await expect.poll(async () =>
      (await current.checkCapability("navigate", {
        tabId: 7,
        destinationUrl: "http://127.0.0.1:3000/guide.pdf",
      })).allowed
    ).toBe(true);

    await expect(
      current.navigateTab({ tabId: 7, url: "http://127.0.0.1:3000/guide.pdf" })
    ).rejects.toMatchObject({
      navigated: true,
      report: { kind: "pdf", message: RESTRICTED_PAGE_MESSAGE, scriptable: false },
      tabId: 7,
      requestedUrl: "http://127.0.0.1:3000/guide.pdf",
    });
    expect(worker.received.some((message) => message.type === "navigate-tab")).toBe(true);
  });

  it("can leave a chrome:// tab for an allowed http page", async () => {
    const current = await start();
    devtools = new FakeExtension({ port: current.port, tabId: 4 });
    let probePopup = false;
    worker = new FakeExtension({
      port: current.port,
      role: "worker",
      onCapabilityProbe: () => ({
        popupEnabled: probePopup,
        panelEnabled: false,
        liveUrl: "chrome://settings/",
        excludeOrigins: [],
      }),
      onNavigate: async (msg) => ({ ok: true, finalUrl: msg.url, wasDiscarded: false }),
    });
    await devtools.connect();
    await worker.connect();
    worker.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;
    await expect.poll(async () =>
      (await current.checkCapability("navigate", {
        tabId: 4,
        destinationUrl: "http://127.0.0.1:3000/next",
      })).allowed
    ).toBe(true);

    const result = await current.navigateTab({ tabId: 4, url: "http://127.0.0.1:3000/next" });
    expect(result.finalUrl).toBe("http://127.0.0.1:3000/next");
  });

  it("reports a redirect onto an error page or the PDF viewer", async () => {
    const current = await start();
    devtools = new FakeExtension({ port: current.port, tabId: 9 });
    let probePopup = false;
    worker = new FakeExtension({
      port: current.port,
      role: "worker",
      onCapabilityProbe: () => ({
        popupEnabled: probePopup,
        panelEnabled: false,
        liveUrl: "http://127.0.0.1:3000/",
        excludeOrigins: [],
      }),
      onNavigate: () => ({
        ok: true,
        finalUrl: "chrome-error://chromewebdata/",
        wasDiscarded: false,
      }),
    });
    await devtools.connect();
    await worker.connect();
    worker.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;
    await expect.poll(async () =>
      (await current.checkCapability("navigate", {
        tabId: 9,
        destinationUrl: "http://127.0.0.1:9/",
      })).allowed
    ).toBe(true);

    await expect(current.navigateTab({ tabId: 9, url: "http://127.0.0.1:9/" })).rejects.toMatchObject({
      navigated: true,
      report: { kind: "chrome", url: "chrome-error://chromewebdata/" },
    });
  });
});

describe("restricted pages through MCP tools", () => {
  let connector: Connector;
  let extension: FakeExtension | undefined;
  let client: Client;
  let closeServer: () => Promise<void>;

  afterEach(async () => {
    await closeServer?.();
    await extension?.close();
    await connector?.close();
  });

  async function start(options: { onScreenshot?: (msg: unknown) => unknown } = {}) {
    const screenshotDir = path.join(os.tmpdir(), `bt-restricted-mcp-${Date.now()}`);
    connector = await createConnector({ port: 0, screenshotDir, allowInput: true, requestTimeoutMs: 3_000 });
    const { server } = createMcpServer({ client: new InProcessConnectorClient(connector) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = async () => {
      await client.close();
      await server.close();
    };
    extension = new FakeExtension({ port: connector.port, tabId: 3, ...options });
    await extension.connect();
    await extension.waitForWelcome();
  }

  it("annotates page info and the tab list, and fails reads with the shared JSON", async () => {
    await start();
    extension!.send({ type: "page", url: "chrome://settings/" });

    await expect
      .poll(async () => {
        const page = await client.callTool({ name: "getPageInfo", arguments: {} });
        return (page.structuredContent as { url?: string } | undefined)?.url;
      })
      .toBe("chrome://settings/");

    const page = await client.callTool({ name: "getPageInfo", arguments: {} });
    expect(page.isError).toBeFalsy();
    expect(page.structuredContent).toMatchObject({
      url: "chrome://settings/",
      access: "metadata-only",
      message: RESTRICTED_PAGE_MESSAGE,
      scriptable: false,
      kind: "chrome",
    });

    const tabs = await client.callTool({ name: "listBrowserTabs", arguments: {} });
    const listed = (tabs.structuredContent as { tabs: Array<Record<string, unknown>> }).tabs[0];
    expect(listed).toMatchObject({
      access: "metadata-only",
      message: RESTRICTED_PAGE_MESSAGE,
      kind: "chrome",
    });

    const logs = await client.callTool({ name: "getConsoleLogs", arguments: {} });
    expect(payloadOf(logs)).toMatchObject({
      kind: "chrome",
      scriptable: false,
      message: RESTRICTED_PAGE_MESSAGE,
    });

    const shot = await client.callTool({ name: "takeScreenshot", arguments: {} });
    expect(payloadOf(shot).kind).toBe("chrome");
    expect(extension!.received.some((message) => message.type === "capture-screenshot")).toBe(false);

    const audit = await client.callTool({
      name: "runSEOAudit",
      arguments: { url: "devtools://devtools/" },
    });
    expect(payloadOf(audit).kind).toBe("devtools");
  });

  it("turns Chrome's devtools capture error into the shared report", async () => {
    await start({
      onScreenshot: () => ({ ok: false, error: 'Cannot access contents of url "devtools://devtools/"' }),
    });
    extension!.send({ type: "page", url: "https://example.com/" });

    await expect
      .poll(async () => {
        const page = await client.callTool({ name: "getPageInfo", arguments: {} });
        return (page.structuredContent as { url?: string } | undefined)?.url;
      })
      .toBe("https://example.com/");

    const shot = await client.callTool({ name: "takeScreenshot", arguments: {} });
    expect(payloadOf(shot)).toMatchObject({ kind: "devtools", scriptable: false });
  });

  it("refuses navigateBrowser with the same JSON the CLI prints", async () => {
    await start();
    const viaMcp = await client.callTool({
      name: "navigateBrowser",
      arguments: { url: "chrome://settings", tabId: 3 },
    });
    expect(payloadOf(viaMcp)).toMatchObject({ kind: "chrome", navigated: false });

    const viaCli = await invokeTool("navigateBrowser", new InProcessConnectorClient(connector), {
      url: "https://chrome.google.com/webstore/detail/foo",
      tabId: 3,
    });
    expect(payloadOf(viaCli)).toMatchObject({ kind: "web-store", navigated: false });
  });
});
