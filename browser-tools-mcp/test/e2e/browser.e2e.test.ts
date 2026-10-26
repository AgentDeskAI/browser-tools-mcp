import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { browserAvailability } from "../helpers/browser-available";
import { e2eChromiumOptions } from "../helpers/e2e-chromium";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector, type Connector } from "../../src/connector/connector";
import { InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";
import { waitForPortFree } from "../helpers/port";

/**
 * Everything that needs a real browser with the real extension loaded.
 *
 * Deliberately one file. The extension discovers the connector on a fixed
 * loopback port, so a second file launching its own browser and binding the
 * same port races the first — which produced tests that passed alone and failed
 * together. One browser, one connector, one tab for the whole suite.
 *
 * Most tests use a single tab so that "the current tab" is unambiguous without
 * naming it. The final block opens a second tab on purpose, to prove targeting
 * works when it is ambiguous.
 */

// Skips rather than fails where no browser can start — see the helper.
const browserSupport = await browserAvailability();
if (!browserSupport.usable) console.warn(`\n  SKIPPED: ${browserSupport.reason}\n`);

const extensionPath = path.resolve(
  fileURLToPath(new URL("../../../chrome-extension", import.meta.url))
);

let connector: Connector;
let fixture: FixtureServer;
let context: BrowserContext | null = null;
let client: Client;
let closeServer: (() => Promise<void>) | null = null;
let userDataDir: string;
let screenshotDir: string;

const SCREENSHOT_BUDGET = 200_000;

beforeAll(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-e2e-shots-"));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-e2e-profile-"));

  fixture = await startFixtureServer();

  // The extension only scans loopback ports 3025-3035.
  await waitForPortFree(3025);
  // Long heartbeat: a backgrounded DevTools page is timer-throttled and can
  // miss pongs, get dropped, then reconnect and take over as the active tab.
  connector = await createConnector({
    port: 3025,
    screenshotDir,
    heartbeatIntervalMs: 30_000,
  });

  const { server } = createMcpServer({ client: new InProcessConnectorClient(connector) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "e2e-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeServer = async () => {
    await client.close();
    await server.close();
  };

  if (!process.env["CHROME_PATH"]) {
    process.env["CHROME_PATH"] = chromium.executablePath();
  }

  // Headless unless HEADED=1. See e2e-chromium.ts.
  context = await chromium.launchPersistentContext(userDataDir, {
    ...browserSupport.launchOptions,
    viewport: { width: 1280, height: 800 },
    ...e2eChromiumOptions([
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      // Loads the extension's devtools page, where all capture logic lives.
      "--auto-open-devtools-for-tabs",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
    ]),
  });
}, 240_000);

afterAll(async () => {
  await closeServer?.();
  await context?.close().catch(() => {});
  await connector?.close();
  await fixture?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 45_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out. Last value: ${JSON.stringify(last)?.slice(0, 500)}`);
}

/** Resolves once the connector reports this path as the page it is watching. */
async function waitForActiveTab(pathname: string) {
  await waitFor(
    () => connector.store.getCurrentPage().url,
    (url) => typeof url === "string" && url.endsWith(`/${pathname}`),
    45_000
  );
}

/**
 * Navigates the single tab and returns once capture is live for it.
 *
 * DevTools reports network activity only from when its listeners register, and
 * the extension's devtools page finishes wiring up slightly after the first
 * navigation has already issued its requests. Reloading once connected
 * reproduces what a user sees: DevTools open, then the page loads.
 */
async function loadPage(pathname = "index.html"): Promise<Page> {
  const page = context!.pages()[0] ?? (await context!.newPage());

  await page.goto(`${fixture.url}${pathname}`, { waitUntil: "load" });
  await waitForActiveTab(pathname);

  connector.store.wipe();
  await page.reload({ waitUntil: "load" });
  await waitForActiveTab(pathname);
  return page;
}

// ---------------------------------------------------------------- capture

describe.skipIf(!browserSupport.usable)("extension to connector", () => {
  it("loads the extension and connects to the connector", async () => {
    await loadPage();
    expect(connector.hasExtension()).toBe(true);
  }, 180_000);

  it("captures console output from the page", async () => {
    await loadPage();

    const result = await waitFor(
      () => connector.store.queryConsole({}),
      (r) => r.entries.some((e) => e.message.includes("MARKER-CONSOLE-LOG"))
    );

    const messages = result.entries.map((e) => e.message).join("\n");
    expect(messages).toContain("MARKER-CONSOLE-LOG");
    expect(messages).toContain("MARKER-CONSOLE-ERROR");
  }, 180_000);

  it("classifies console errors", async () => {
    await loadPage();

    const errors = await waitFor(
      () => connector.store.queryConsole({ errorsOnly: true }),
      (r) => r.entries.some((e) => e.message.includes("MARKER-CONSOLE-ERROR"))
    );

    expect(errors.entries.every((e) => e.level === "error" || e.level === "assert")).toBe(true);
  }, 180_000);

  it("captures network requests, including failures", async () => {
    await loadPage();

    const all = await waitFor(
      () => connector.store.queryNetwork({}),
      (r) => r.entries.some((e) => e.url.includes("/api/ok"))
    );
    expect(all.entries.some((e) => e.url.includes("/api/ok"))).toBe(true);

    const failures = await waitFor(
      () => connector.store.queryNetwork({ errorsOnly: true }),
      (r) => r.entries.some((e) => e.url.includes("/api/fail"))
    );
    expect(failures.entries.find((e) => e.url.includes("/api/fail"))?.status).toBe(500);
  }, 180_000);

  it("scrubs credentials before they reach the store", async () => {
    await loadPage();

    await waitFor(
      () => connector.store.queryNetwork({}),
      (r) => r.entries.some((e) => e.url.includes("/api/secret"))
    );

    const everything = JSON.stringify({
      console: connector.store.queryConsole({}),
      network: connector.store.queryNetwork({}),
    });

    expect(everything).not.toContain("SUPERSECRETCOOKIEVALUE");
    expect(everything).not.toContain("ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789");
  }, 180_000);

  /**
   * Regression from a real leak found in manual testing against a live
   * Clerk-authenticated app: a JWT and four session ids reached the store.
   * The JWT was longer than the truncation limit, so it arrived as a single
   * segment and no longer matched the token pattern; session ids had no pattern
   * at all and appeared in the request URL as well as the body.
   */
  it("scrubs auth tokens even when they are longer than the truncation limit", async () => {
    await loadPage();

    await waitFor(
      () => connector.store.queryNetwork({}),
      (r) => r.entries.some((e) => e.url.includes("/v1/client/sessions/"))
    );

    const captured = JSON.stringify({
      console: connector.store.queryConsole({}),
      network: connector.store.queryNetwork({}),
      exportedConsole: connector.exportConsole({ allTabs: true }),
      exportedNetwork: connector.exportNetwork({ allTabs: true }),
    });

    // The session id leaked through both the URL path and the response body.
    expect(captured).not.toContain("sess_3HWEvAAPLW3pElwMd0oolLs5aF7");
    expect(captured).not.toContain("client_3GmhO0nHNv39mTjwcKR6AbTJW0F");
    // A JWT header survives truncation as a lone segment; it must still go.
    expect(captured).not.toMatch(/eyJhbGciOiJSUzI1NiIsImNhdCI6/);
    expect(captured).toContain("[REDACTED]");

    // The request is still recognisable, or the log stops being useful.
    expect(captured).toContain("/v1/client/sessions/");
  }, 180_000);

  it("tracks the page the browser is on", async () => {
    await loadPage();
    expect(connector.store.getCurrentPage().url).toContain("127.0.0.1");
  }, 180_000);

  it("takes a real screenshot of the inspected page", async () => {
    await loadPage();

    const result = await connector.captureScreenshot({});

    expect(fs.existsSync(result.path)).toBe(true);
    const bytes = fs.readFileSync(result.path);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(bytes.length).toBeGreaterThan(1000);
    expect(result.path.startsWith(path.resolve(screenshotDir))).toBe(true);
  }, 180_000);

  it("reloads the page on request", async () => {
    await loadPage();

    connector.store.wipe();
    await connector.refreshTab();

    await waitFor(
      () => connector.store.queryConsole({}),
      (r) => r.entries.some((e) => e.message.includes("MARKER-CONSOLE-LOG"))
    );
  }, 180_000);

  it("reads web storage through the extension", async () => {
    const page = await loadPage();
    await page.evaluate(() => localStorage.setItem("btmcp-e2e", "MARKER-STORAGE-VALUE"));

    const storage = await connector.readStorage(["localStorage"]);
    expect(JSON.stringify(storage)).toContain("btmcp-e2e");
    expect(JSON.stringify(storage)).toContain("MARKER-STORAGE-VALUE");
  }, 180_000);
});

// ------------------------------------------------------------- full chain

describe.skipIf(!browserSupport.usable)("MCP client to real browser", () => {
  it("reports the extension as connected through getConnectionStatus", async () => {
    await loadPage();

    const result: any = await waitFor(
      () => client.callTool({ name: "getConnectionStatus", arguments: {} }),
      (r: any) => r.structuredContent?.extensionConnected === true
    );
    expect(result.structuredContent.extensionConnected).toBe(true);
  }, 180_000);

  it("returns real console output as structured content", async () => {
    await loadPage();

    const result: any = await waitFor(
      () => client.callTool({ name: "getConsoleLogs", arguments: {} }),
      (r: any) =>
        (r.structuredContent?.entries ?? []).some((e: any) =>
          e.message?.includes("MARKER-CONSOLE-LOG")
        )
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.total).toBeGreaterThan(0);
  }, 180_000);

  it("filters real console output by keyword through the tool interface", async () => {
    await loadPage();

    await waitFor(
      () => client.callTool({ name: "getConsoleLogs", arguments: {} }),
      (r: any) =>
        (r.structuredContent?.entries ?? []).some((e: any) =>
          e.message?.includes("MARKER-CONSOLE-WARN")
        )
    );

    const filtered: any = await client.callTool({
      name: "getConsoleLogs",
      arguments: { keywords: ["MARKER-CONSOLE-WARN"] },
    });

    expect(filtered.structuredContent.entries.length).toBeGreaterThan(0);
    expect(
      filtered.structuredContent.entries.every((e: any) =>
        e.message.includes("MARKER-CONSOLE-WARN")
      )
    ).toBe(true);
  }, 180_000);

  it("returns real failed requests from getNetworkErrors", async () => {
    await loadPage();

    const result: any = await waitFor(
      () => client.callTool({ name: "getNetworkErrors", arguments: {} }),
      (r: any) =>
        (r.structuredContent?.entries ?? []).some((e: any) => e.url?.includes("/api/fail"))
    );

    expect(result.isError).toBeFalsy();
    expect(
      result.structuredContent.entries.find((e: any) => e.url.includes("/api/fail")).status
    ).toBe(500);
  }, 180_000);

  it("delivers a real screenshot as an image block", async () => {
    await loadPage();

    const result: any = await client.callTool({ name: "takeScreenshot", arguments: {} });

    expect(result.isError).toBeFalsy();
    const image = result.content.find((c: any) => c.type === "image");
    expect(image).toBeTruthy();

    const bytes = Buffer.from(image.data, "base64");
    expect(bytes.length).toBeGreaterThan(1000);
    expect(result.structuredContent.imageIncluded).toBe(true);
    expect(fs.existsSync(result.structuredContent.path)).toBe(true);
  }, 180_000);

  it("reports the real page through getPageInfo", async () => {
    await loadPage();

    const result: any = await waitFor(
      () => client.callTool({ name: "getPageInfo", arguments: {} }),
      (r: any) =>
        typeof r.structuredContent?.url === "string" &&
        r.structuredContent.url.includes("127.0.0.1")
    );
    expect(result.structuredContent.extensionConnected).toBe(true);
  }, 180_000);

  it("reloads the real page through refreshBrowser", async () => {
    await loadPage();

    await client.callTool({ name: "wipeLogs", arguments: {} });
    const result: any = await client.callTool({ name: "refreshBrowser", arguments: {} });
    expect(result.isError).toBeFalsy();

    await waitFor(
      () => client.callTool({ name: "getConsoleLogs", arguments: {} }),
      (r: any) =>
        (r.structuredContent?.entries ?? []).some((e: any) =>
          e.message?.includes("MARKER-CONSOLE-LOG")
        )
    );
  }, 180_000);

  it("withholds real storage values until asked, then returns them", async () => {
    const page = await loadPage();
    await page.evaluate(() => localStorage.setItem("chain-key", "CHAIN-SECRET-VALUE"));

    const hidden: any = await client.callTool({
      name: "getBrowserStorage",
      arguments: { kinds: ["localStorage"] },
    });
    expect(JSON.stringify(hidden)).toContain("chain-key");
    expect(JSON.stringify(hidden)).not.toContain("CHAIN-SECRET-VALUE");

    const shown: any = await client.callTool({
      name: "getBrowserStorage",
      arguments: { kinds: ["localStorage"], includeValues: true },
    });
    expect(JSON.stringify(shown)).toContain("CHAIN-SECRET-VALUE");
  }, 180_000);

  it("runs a real audit of the live page through the MCP tool", async () => {
    await loadPage();

    // No url argument: the tool must resolve the page the browser is on.
    const result: any = await client.callTool({ name: "runSEOAudit", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.category).toBe("seo");
    expect(result.structuredContent.metadata.url).toContain("127.0.0.1");
  }, 240_000);
});

// --------------------------------------------------------- screenshot size

describe.skipIf(!browserSupport.usable)("screenshot byte budget", () => {
  /**
   * Measured before the budget existed: a viewport capture of dense content ran
   * to 13.3 MB of base64 on a 1440p retina display and 17.9 MB on an ultrawide.
   * Both exceed the 10 MB read buffer newer MCP stdio transports enforce, which
   * closes the connection, and either would swamp a model's context.
   */
  async function loadNoisePage() {
    const page = await loadPage("noise");
    await page.waitForTimeout(800); // let the canvas paint
    return page;
  }

  it("produces a genuinely large capture when the budget is generous", async () => {
    await loadNoisePage();
    connector.store.updateSettings({ screenshotMaxBytes: 9_000_000 });

    const result = await connector.captureScreenshot({});

    // Establishes the fixture really is a worst case; without this the budget
    // test below could pass vacuously on a trivially small image.
    expect(result.bytes).toBeGreaterThan(500_000);
    expect(result.mimeType).toBe("image/png");
    expect(result.withinBudget).toBe(true);
  }, 180_000);

  it("degrades format and scale to meet a tight budget", async () => {
    await loadNoisePage();
    connector.store.updateSettings({ screenshotMaxBytes: SCREENSHOT_BUDGET });

    const result = await connector.captureScreenshot({});

    expect(result.bytes).toBeLessThanOrEqual(SCREENSHOT_BUDGET);
    expect(result.withinBudget).toBe(true);
    // PNG cannot compress noise, so meeting the budget requires JPEG.
    expect(result.mimeType).toBe("image/jpeg");
  }, 180_000);

  it("writes a genuinely valid JPEG, not renamed PNG bytes", async () => {
    await loadNoisePage();
    connector.store.updateSettings({ screenshotMaxBytes: SCREENSHOT_BUDGET });

    const result = await connector.captureScreenshot({});
    const bytes = fs.readFileSync(result.path);

    expect(result.path.endsWith(".jpg")).toBe(true);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // SOI
    expect(bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9])); // EOI
    expect(bytes.length).toBeLessThanOrEqual(SCREENSHOT_BUDGET);
  }, 180_000);

  it("still captures an ordinary page as png without degrading it", async () => {
    await loadPage();
    connector.store.updateSettings({ screenshotMaxBytes: SCREENSHOT_BUDGET });

    const result = await connector.captureScreenshot({});

    // A normal page compresses well, so quality should not be sacrificed.
    expect(result.mimeType).toBe("image/png");
    expect(result.withinBudget).toBe(true);
  }, 180_000);

  it("never exceeds the transport's 10 MB read buffer at the default budget", async () => {
    await loadNoisePage();
    connector.store.updateSettings({ screenshotMaxBytes: 3_000_000 });

    const result = await connector.captureScreenshot({});

    expect(result.bytes).toBeLessThanOrEqual(3_000_000);
    expect(result.data.length).toBeLessThan(10 * 1024 * 1024);
  }, 180_000);
});

// --------------------------------------------------------------- multi-tab

describe.skipIf(!browserSupport.usable)("two real tabs", () => {
  /**
   * The rest of this file deliberately uses one tab. This is the case that
   * used to be broken: with DevTools open on two tabs, telemetry and
   * screenshots followed whichever tab most recently connected or navigated.
   */
  let second: Page | null = null;

  afterAll(async () => {
    await second?.close().catch(() => {});
    second = null;
  });

  it("registers both tabs with distinct ids and urls", async () => {
    await loadPage();

    second = await context!.newPage();
    await second.goto(`${fixture.url}noise`, { waitUntil: "load" });

    const tabs = await waitFor(
      () => connector.listTabs(),
      (list) => list.length === 2 && list.every((tab) => tab.url.length > 0)
    );

    const ids = tabs.map((tab) => tab.tabId);
    expect(new Set(ids).size).toBe(2);
    expect(tabs.some((tab) => tab.url.endsWith("/index.html"))).toBe(true);
    expect(tabs.some((tab) => tab.url.endsWith("/noise"))).toBe(true);
    expect(tabs.filter((tab) => tab.isCurrent)).toHaveLength(1);
  }, 180_000);

  it("attributes each tab's console output to that tab", async () => {
    const tabs = await waitFor(
      () => connector.listTabs(),
      (list) => list.length === 2 && list.every((tab) => tab.url.length > 0)
    );
    const fixtureTab = tabs.find((tab) => tab.url.endsWith("/index.html"))!;
    const noiseTab = tabs.find((tab) => tab.url.endsWith("/noise"))!;

    await waitFor(
      () => connector.store.queryConsole({ tabId: fixtureTab.tabId }),
      (r) => r.entries.some((e) => e.message.includes("MARKER-CONSOLE-LOG"))
    );

    // The noise page logs its own marker and never the fixture's.
    const noiseLogs = connector.store.queryConsole({ tabId: noiseTab.tabId });
    expect(noiseLogs.entries.some((e) => e.message.includes("MARKER-CONSOLE-LOG"))).toBe(false);
  }, 180_000);

  it("screenshots the tab it was told to, not the most recent one", async () => {
    const tabs = await waitFor(
      () => connector.listTabs(),
      (list) => list.length === 2 && list.every((tab) => tab.url.length > 0)
    );
    const fixtureTab = tabs.find((tab) => tab.url.endsWith("/index.html"))!;

    connector.store.updateSettings({ screenshotMaxBytes: 9_000_000 });
    const result = await connector.captureScreenshot({ tabId: fixtureTab.tabId });

    expect(result.tabId).toBe(fixtureTab.tabId);
    expect(result.url.endsWith("/index.html")).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
  }, 180_000);

  it("refuses an unknown tab instead of falling back to some other tab", async () => {
    await expect(connector.captureScreenshot({ tabId: 999999 })).rejects.toThrow(/unknown tab/i);
  }, 60_000);
});
