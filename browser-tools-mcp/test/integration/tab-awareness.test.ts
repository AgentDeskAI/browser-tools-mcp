import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector } from "../../src/connector/connector";
import { InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { invokeTool } from "../../src/mcp/tool-invoke";
import { TAB_COVERAGE } from "../../src/tabs/contract";
import { GateReason } from "../../src/gates/capability";
import { FakeExtension } from "../helpers/fake-extension";

describe("chrome.tabs tools", () => {
  let connector: Awaited<ReturnType<typeof createConnector>> | undefined;
  let worker: FakeExtension | undefined;
  let devtools: FakeExtension | undefined;
  let probePopup = false;

  afterEach(async () => {
    await devtools?.close();
    await worker?.close();
    await connector?.close();
    probePopup = false;
  });

  async function start(allowInput: boolean) {
    const screenshotDir = path.join(os.tmpdir(), `bt-tabs-${Date.now()}-${Math.random()}`);
    connector = await createConnector({ port: 0, screenshotDir, allowInput });
    worker = new FakeExtension({
      port: connector.port,
      role: "worker",
      onCapabilityProbe: () => ({
        popupEnabled: probePopup,
        panelEnabled: false,
        liveUrl: "http://127.0.0.1:3000/app",
        excludeOrigins: [],
      }),
      onListChromeTabs: () => ({
        ok: true,
        visibleWindowId: 1,
        windows: [
          {
            windowId: 1,
            focused: true,
            type: "normal",
            incognito: false,
            tabs: [
              {
                chromeTabId: 4,
                windowId: 1,
                title: "Fixture",
                url: "http://127.0.0.1:3000/app",
                active: true,
                discarded: false,
                frozen: false,
                lastAccessed: 10,
                index: 0,
              },
            ],
          },
          {
            windowId: 9,
            focused: false,
            type: "normal",
            incognito: true,
            tabs: [{ chromeTabId: 99, windowId: 9, title: "Hidden", url: "https://secret.example/", active: true }],
          },
        ],
        safety: { debuggerCalls: 0, focusChanges: 0 },
      }),
      onNavigateChromeTab: (msg) => ({
        ok: true,
        chromeTabId: msg.chromeTabId ?? 15,
        finalUrl: msg.url,
        wasDiscarded: msg.chromeTabId === 4,
        created: msg.create === true,
        visibleWindowId: 1,
        openedTabs: [{ chromeTabId: 16, url: "http://127.0.0.1:3000/popup", windowId: 1, active: false }],
        safety: { debuggerCalls: 0, focusChanges: 0 },
      }),
      onReadChromeTab: () => ({
        ok: true,
        safety: { debuggerCalls: 0, focusChanges: 0 },
        read: {
          url: "http://127.0.0.1:3000/app",
          title: "Fixture",
          asleep: true,
          frozen: false,
          skipped: "asleep",
          headings: [],
          excerpt: "",
          snapshot: [],
          hostAccess: true,
        },
      }),
      onSoftInput: (msg) => ({
        ok: true,
        outcome: msg.selector === "#file" ? "needs a real gesture" : "worked",
        reason: msg.selector === "#file" ? "file picker" : null,
        detail: msg.selector === "#file" ? "A file picker needs a real gesture." : "Value set",
        trusted: false,
        safety: { debuggerCalls: 0, focusChanges: 0 },
      }),
      onSnapshotChromeTab: () => ({
        ok: true,
        safety: { debuggerCalls: 0, focusChanges: 0 },
        snapshot: {
          url: "http://127.0.0.1:3000/app",
          title: "Fixture",
          asleep: false,
          frozen: false,
          skipped: null,
          hostAccess: true,
          truncated: false,
          nodes: [
            {
              ref: "e1",
              role: "button",
              name: "Run check",
              text: "Run check",
              state: {},
              visible: true,
              depth: 1,
            },
          ],
        },
      }),
      onActChromeTab: (msg) => ({
        ok: true,
        chromeTabId: msg.chromeTabId,
        ref: msg.ref,
        outcome: "worked",
        reason: null,
        detail: "Untrusted click was delivered to the element.",
        trusted: false,
        delta: {
          previousUrl: "http://127.0.0.1:3000/app",
          url: "http://127.0.0.1:3000/app?changed=1",
          consoleErrors: ["MARKER-MAP-ERROR"],
          failedRequests: [{ url: "http://127.0.0.1:3000/api/fail", status: 500 }],
        },
        safety: { debuggerCalls: 0, focusChanges: 0 },
      }),
    });
    await worker.connect();
    worker.send({ type: "capability-state", popupEnabled: true });
    probePopup = true;
    await expect.poll(async () => (await connector!.checkCapability("listTabs")).allowed).toBe(true);
  }

  it("lists chrome.tabs metadata and drops incognito", async () => {
    await start(false);
    const listing = await connector!.listChromeTabs();
    expect(listing.coverage).toBe(TAB_COVERAGE);
    expect(listing.windows).toHaveLength(1);
    expect(listing.windows[0]?.tabs[0]).toMatchObject({ chromeTabId: 4, site: "http://127.0.0.1:3000", lastAccessed: 10 });
    expect(JSON.stringify(listing)).not.toContain("secret.example");
    const sent = worker!.received.filter((message) => message.type === "list-chrome-tabs");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(/active"\s*:\s*true|focused"\s*:\s*true|debugger/);
  });

  it("navigates in the background only when input is allowed, and reports popups", async () => {
    await start(true);
    const created = await connector!.navigateChromeTab({ url: "http://127.0.0.1:3000/next" });
    expect(created.created).toBe(true);
    expect(created.chromeTabId).toBe(15);
    expect(created.openedTabs[0]?.url).toContain("/popup");
    expect(created.safety).toEqual({ debuggerCalls: 0, focusChanges: 0 });
    const message = worker!.received.find((entry) => entry.type === "navigate-chrome-tab");
    expect(message.create).toBe(true);
    expect(message.active).toBeUndefined();
    expect(message.focused).toBeUndefined();

    const updated = await connector!.navigateChromeTab({
      url: "http://127.0.0.1:3000/woken",
      chromeTabId: 4,
    });
    expect(updated.wasDiscarded).toBe(true);
    expect(updated.created).toBe(false);
  });

  it("refuses navigation when input is off and when the action would change focus", async () => {
    await start(false);
    await expect
      .poll(async () =>
        (await connector!.checkCapability("navigate", {
          creatingTab: true,
          destinationUrl: "http://127.0.0.1:3000/next",
        })).reason
      )
      .toBe(GateReason.inputOff);
    await expect(connector!.navigateChromeTab({ url: "http://127.0.0.1:3000/next" })).rejects.toThrow(GateReason.inputOff);

    await connector!.close();
    await worker!.close();
    await start(true);
    worker!.received.length = 0;
    const previous = worker!;
    // Replace the navigate handler by closing and using a worker that reports a focus change.
    await previous.close();
    worker = new FakeExtension({
      port: connector!.port,
      role: "worker",
      onCapabilityProbe: () => ({
        popupEnabled: true,
        panelEnabled: false,
        liveUrl: "http://127.0.0.1:3000/app",
        excludeOrigins: [],
      }),
      onNavigateChromeTab: () => ({
        ok: true,
        chromeTabId: 4,
        finalUrl: "http://127.0.0.1:3000/next",
        wasDiscarded: false,
        created: false,
        visibleWindowId: 1,
        openedTabs: [],
        safety: { debuggerCalls: 0, focusChanges: 1 },
      }),
    });
    await worker.connect();
    worker.send({ type: "capability-state", popupEnabled: true });
    await expect
      .poll(async () =>
        (await connector!.checkCapability("navigate", {
          tabId: 4,
          destinationUrl: "http://127.0.0.1:3000/next",
        })).allowed
      )
      .toBe(true);
    await expect(
      connector!.navigateChromeTab({ url: "http://127.0.0.1:3000/next", chromeTabId: 4 })
    ).rejects.toThrow(/change focus/);
  });

  it("reads an asleep tab and reports soft click outcomes through MCP and the CLI path", async () => {
    await start(true);
    const read = await connector!.readChromeTab({ chromeTabId: 4 });
    expect(read).toMatchObject({ asleep: true, skipped: "asleep", chromeTabId: 4 });

    const click = await connector!.softClickChromeTab({ chromeTabId: 4, selector: "#file" });
    expect(click).toMatchObject({ outcome: "needs a real gesture", reason: "file picker", trusted: false });
    const typed = await connector!.softTypeChromeTab({ chromeTabId: 4, selector: "#name", text: "Ada" });
    expect(typed).toMatchObject({ outcome: "worked", trusted: false });

    const client = new InProcessConnectorClient(connector!);
    const invoked = await invokeTool("listTabs", client, {});
    expect(invoked.isError).toBeUndefined();
    expect(invoked.structuredContent?.["coverage"]).toBe(TAB_COVERAGE);

    const { server } = createMcpServer({ client });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "tab-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    const listed = await mcp.listTools();
    const listTabs = listed.tools.find((tool) => tool.name === "listTabs");
    const navigate = listed.tools.find((tool) => tool.name === "navigateTab");
    expect(listTabs?.description).toContain("This is not every open tab");
    expect(listTabs?.description).not.toMatch(/every tab you have|all open tabs/);
    expect(navigate?.description).toContain("chromeTabId");
    expect(navigate?.description).toContain("not a DevTools-connected tabId");
    expect(navigate?.description).toContain("visible window");
    const called = await mcp.callTool({ name: "softType", arguments: { chromeTabId: 4, selector: "#name", text: "Ada" } });
    expect(called.isError).toBeUndefined();
    const mapTool = listed.tools.find((tool) => tool.name === "snapshotTab");
    const actTool = listed.tools.find((tool) => tool.name === "actOnRef");
    expect(mapTool?.description).toContain("stable ref");
    expect(mapTool?.description).not.toMatch(/computer[- ]use/i);
    expect(actTool?.description).toContain("console errors");
    expect(actTool?.description).not.toMatch(/computer[- ]use/i);
    await mcp.close();
    await server.close();
  });

  it("maps a tab without input permission and refuses an action until input is allowed", async () => {
    await start(false);
    const snapshot = await connector!.snapshotChromeTab({ chromeTabId: 4 });
    expect(snapshot.nodes[0]).toMatchObject({ ref: "e1", role: "button", name: "Run check", visible: true });
    await expect(connector!.actOnChromeTabRef({ chromeTabId: 4, ref: "e1", op: "click" })).rejects.toThrow(/input is not allowed/);
    expect(worker!.received.some((message) => message.type === "act-chrome-tab")).toBe(false);
  });

  it("returns a what-changed delta after acting on a ref and refuses a focus change", async () => {
    await start(true);
    const client = new InProcessConnectorClient(connector!);
    const acted = await invokeTool("actOnRef", client, { chromeTabId: 4, ref: "e1", op: "click" });
    expect(acted.isError).toBeUndefined();
    expect(acted.structuredContent).toMatchObject({
      ref: "e1",
      outcome: "worked",
      trusted: false,
      delta: {
        urlChanged: true,
        consoleErrors: ["MARKER-MAP-ERROR"],
        failedRequests: [{ url: "http://127.0.0.1:3000/api/fail", status: 500 }],
      },
    });
    const sent = worker!.received.filter((message) => message.type === "act-chrome-tab");
    expect(sent.at(-1)).toMatchObject({ ref: "e1", op: "click", chromeTabId: 4 });

    await worker!.close();
    worker = new FakeExtension({
      port: connector!.port,
      role: "worker",
      onCapabilityProbe: () => ({
        popupEnabled: true,
        panelEnabled: false,
        liveUrl: "http://127.0.0.1:3000/app",
        excludeOrigins: [],
      }),
      onActChromeTab: () => ({
        ok: true,
        outcome: "worked",
        reason: null,
        detail: "clicked",
        trusted: false,
        delta: {
          previousUrl: "http://127.0.0.1:3000/app",
          url: "http://127.0.0.1:3000/app",
          consoleErrors: [],
          failedRequests: [],
        },
        safety: { debuggerCalls: 0, focusChanges: 1 },
      }),
    });
    await worker.connect();
    worker.send({ type: "capability-state", popupEnabled: true });
    await expect
      .poll(async () => (await connector!.checkCapability("softClick", { tabId: 4 })).allowed)
      .toBe(true);
    await expect(connector!.actOnChromeTabRef({ chromeTabId: 4, ref: "e1", op: "click" })).rejects.toThrow(/change focus/);
  });
});
