import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector, type Connector } from "../../src/connector/connector";
import { InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { browserAvailability } from "../helpers/browser-available";
import { e2eChromiumOptions } from "../helpers/e2e-chromium";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";
import { waitForPortFree } from "../helpers/port";

/**
 * Tab awareness with DevTools closed.
 *
 * The other end-to-end file opens DevTools, which attaches chrome.debugger on
 * purpose. This one must not: list and navigate go through chrome.tabs only,
 * and the tab the user is looking at stays active.
 */
const browserSupport = await browserAvailability();
if (!browserSupport.usable) console.warn(`\n  SKIPPED: ${browserSupport.reason}\n`);

const extensionPath = path.resolve(fileURLToPath(new URL("../../../chrome-extension", import.meta.url)));

let connector: Connector;
let fixture: FixtureServer;
let context: BrowserContext | null = null;
let client: Client;
let closeServer: (() => Promise<void>) | null = null;
let userDataDir: string;
let page: Page;

beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-e2e-tabs-"));
  fixture = await startFixtureServer();
  await waitForPortFree(3026);
  connector = await createConnector({
    port: 3026,
    screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), "bt-e2e-tabs-shots-")),
    allowInput: true,
    heartbeatIntervalMs: 30_000,
  });

  const { server } = createMcpServer({ client: new InProcessConnectorClient(connector) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "e2e-tabs", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeServer = async () => {
    await client.close();
    await server.close();
  };

  if (!browserSupport.usable) return;

  context = await chromium.launchPersistentContext(userDataDir, {
    ...browserSupport.launchOptions,
    viewport: { width: 1100, height: 800 },
    ...e2eChromiumOptions([
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
    ]),
  });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
}, 240_000);

afterAll(async () => {
  await closeServer?.();
  await context?.close().catch(() => {});
  await connector?.close();
  await fixture?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

async function extensionWorker() {
  const existing = context!.serviceWorkers().find((worker) => worker.url().includes("chrome-extension://"));
  if (existing) return existing;
  return context!.waitForEvent("serviceworker", { timeout: 30_000 });
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((block) => block.type === "text");
  const body = text && "text" in text ? text.text : "";
  if (result.isError) throw new Error(body);
  return JSON.parse(body) as Record<string, unknown>;
}

async function browserState() {
  const sw = await extensionWorker();
  return sw.evaluate(async () => {
    const chromeApi = (globalThis as unknown as { chrome: any }).chrome;
    const [active] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
    const safety = (globalThis as unknown as { __btmcpSafety?: { snapshot: () => { debuggerCalls: number; focusChanges: number } } }).__btmcpSafety?.snapshot() ?? {
      debuggerCalls: -1,
      focusChanges: -1,
    };
    return {
      activeId: active && active.id,
      activeUrl: active && active.url,
      windowId: active && active.windowId,
      safety,
    };
  });
}

/** True only if this extension has called chrome.debugger.attach on the tab. */
async function extensionDebuggerAttached(tabId: number): Promise<boolean> {
  const sw = await extensionWorker();
  return sw.evaluate(async (id: number) => {
    const chromeApi = (globalThis as unknown as { chrome: any }).chrome;
    try {
      await new Promise((resolve, reject) => {
        chromeApi.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", { expression: "1" }, () => {
          const message = chromeApi.runtime.lastError?.message;
          if (message) reject(new Error(message));
          else resolve(true);
        });
      });
      return true;
    } catch {
      return false;
    }
  }, tabId);
}

describe("tab awareness without DevTools", () => {
  it.skipIf(!browserSupport.usable)(
    "lists, navigates, reads, and soft-inputs without attaching the debugger or stealing focus",
    async () => {
      const sw = await extensionWorker();
      await sw.evaluate(async () => {
        const chromeApi = (globalThis as unknown as { chrome: any }).chrome;
        await chromeApi.storage.session.set({ btmcpPopupSwitch: true });
      });

      let listing: Record<string, unknown> | undefined;
      const deadline = Date.now() + 45_000;
      let lastError = "";
      while (Date.now() < deadline) {
        try {
          listing = await callTool("listTabs");
          const blob = JSON.stringify(listing);
          if (blob.includes(String(fixture.port))) break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (!listing || !JSON.stringify(listing).includes(String(fixture.port))) {
        throw new Error(`listTabs did not see the fixture. Last error: ${lastError}`);
      }

      expect(listing["coverage"]).toMatch(/This is not every open tab/);
      expect(String(listing["coverage"])).not.toMatch(/every tab you have|all open tabs/);

      const before = await browserState();
      expect(before.safety.debuggerCalls).toBe(0);
      expect(before.safety.focusChanges).toBe(0);

      const opened = await callTool("navigateTab", { url: `${fixture.url}form` });
      expect(opened["created"]).toBe(true);
      expect(opened["safety"]).toEqual({ debuggerCalls: 0, focusChanges: 0 });
      const chromeTabId = opened["chromeTabId"] as number;

      const afterNavigate = await browserState();
      expect(afterNavigate.activeId).toBe(before.activeId);
      expect(afterNavigate.activeUrl).toBe(before.activeUrl);
      expect(afterNavigate.windowId).toBe(before.windowId);
      expect(afterNavigate.safety).toEqual({ debuggerCalls: 0, focusChanges: 0 });
      expect(page.url()).toBe(fixture.url);

      const read = await callTool("readTab", { chromeTabId });
      expect(read["asleep"]).toBe(false);
      expect(JSON.stringify(read["headings"])).toContain("Soft form");
      expect(JSON.stringify(read)).not.toContain("user@example.com");

      const file = await callTool("softClick", { chromeTabId, selector: "#file" });
      expect(file).toMatchObject({ outcome: "needs a real gesture", reason: "file picker", trusted: false });

      const typed = await callTool("softType", {
        chromeTabId,
        selector: "#name",
        text: "Ada",
        submit: true,
      });
      expect(typed).toMatchObject({ outcome: "worked", trusted: false });

      const settled = await browserState();
      expect(settled.activeId).toBe(before.activeId);
      expect(settled.activeUrl).toBe(before.activeUrl);
      expect(settled.safety).toEqual({ debuggerCalls: 0, focusChanges: 0 });

      // The result page's title replaces the URL only after load. listTabs can
      // observe the tab while it is still loading.
      let again: Record<string, unknown> | undefined;
      const titleDeadline = Date.now() + 5_000;
      while (Date.now() < titleDeadline) {
        again = await callTool("listTabs");
        if (JSON.stringify(again).includes("Form result")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const tabs = JSON.stringify(again);
      expect(tabs).toContain("Form result");
      expect(tabs).toContain(String(before.activeId));

      // After the product path. sendCommand counts as a debugger call, so this
      // stays last. A miss means the extension never attached.
      expect(await extensionDebuggerAttached(chromeTabId)).toBe(false);
      expect(await extensionDebuggerAttached(before.activeId as number)).toBe(false);
    },
    180_000
  );
});
