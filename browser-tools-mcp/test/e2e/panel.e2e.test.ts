import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { browserAvailability } from "../helpers/browser-available";
import { e2eChromiumOptions } from "../helpers/e2e-chromium";
import { chromium, type BrowserContext, type Page } from "playwright";

/**
 * The DevTools panel UI, loaded from the real extension origin.
 *
 * Playwright cannot reach the devtools:// frontend, and driving it over raw CDP
 * depends on undocumented internals that change between Chrome versions. So the
 * panel page itself is loaded directly at chrome-extension://<id>/panel.html —
 * real markup, real shared.js, real panel.js, real extension CSP — with only
 * `window.btmcp` stubbed, which is precisely the object devtools.js injects at
 * runtime. The stub's shape is pinned against devtools.js by the contract tests
 * at the bottom of this file.
 */

// Skips rather than fails where no browser can start — see the helper.
const browserSupport = await browserAvailability();
if (!browserSupport.usable) console.warn(`\n  SKIPPED: ${browserSupport.reason}\n`);

const extensionPath = path.resolve(
  fileURLToPath(new URL("../../../chrome-extension", import.meta.url))
);

let context: BrowserContext | null = null;
let userDataDir: string;
let extensionId: string;
let page: Page;
let pageErrors: string[] = [];

const STUB_SETTINGS = {
  serverHost: "127.0.0.1",
  serverPort: 3025,
  logLimit: 50,
  queryLimit: 30000,
  stringSizeLimit: 500,
  maxLogSize: 20000,
  showRequestHeaders: false,
  showResponseHeaders: true,
  captureConsole: true,
  captureNetwork: true,
  captureResponseBodies: false,
  captureMode: "debugger",
};

/** Installed before any page script runs, so panel.js never sees it missing. */
function bridgeStub(settings: Record<string, unknown>) {
  return `
    window.__calls = [];
    window.__cookieGrant = true;
    window.btmcp = {
      getStatus: () => ({ type: "status", state: "connecting", detail: "", server: null }),
      getSettings: () => (${JSON.stringify(settings)}),
      updateSettings: async (next) => { window.__calls.push(["updateSettings", next]); },
      reconnect: () => { window.__calls.push(["reconnect"]); },
      subscribe: (listener) => {
        window.__listener = listener;
        listener(window.btmcp.getStatus());
        return () => {};
      },
      requestCookiePermission: async () => {
        window.__calls.push(["requestCookiePermission"]);
        return window.__cookieGrant;
      },
    };
    window.__pushStatus = (status) => window.__listener(status);
  `;
}

/**
 * Chrome derives an unpacked extension's id from the SHA-256 of its absolute
 * path, mapping each nibble onto a-p.
 *
 * Computing it beats discovering it from a devtools target, because this test
 * can then run with DevTools closed. With --auto-open-devtools-for-tabs the
 * extension's devtools page attaches to every tab — including panel.html — and
 * connects to whatever connector is listening, polluting the other end-to-end
 * suite's tab registry.
 */
function unpackedExtensionId(absolutePath: string): string {
  const hash = crypto.createHash("sha256").update(absolutePath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    const byte = hash[i]!;
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0xf));
  }
  return id;
}

beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-panel-profile-"));
  // Headless unless HEADED=1. See e2e-chromium.ts.
  context = await chromium.launchPersistentContext(userDataDir, {
    ...browserSupport.launchOptions,
    ...e2eChromiumOptions([
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
    ]),
  });
  extensionId = unpackedExtensionId(extensionPath);

  // Fail loudly if Chrome ever changes how it derives unpacked ids, rather
  // than silently testing a page that does not exist.
  const probe = await context.newPage();
  const response = await probe.goto(`chrome-extension://${extensionId}/panel.html`);
  expect(response?.status(), "extension id derivation is stale").toBeLessThan(400);
  await probe.close();
}, 180_000);

afterAll(async () => {
  await context?.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

async function openPanel(settings = STUB_SETTINGS): Promise<Page> {
  const panel = await context!.newPage();
  pageErrors = [];
  panel.on("pageerror", (error) => pageErrors.push(error.message));
  await panel.addInitScript(bridgeStub(settings));
  await panel.goto(`chrome-extension://${extensionId}/panel.html`, {
    waitUntil: "domcontentloaded",
  });
  // panel.js wires up after it sees the bridge.
  await panel.waitForFunction(() => document.getElementById("host")?.value !== "");
  return panel;
}

describe.skipIf(!browserSupport.usable)("panel UI in the real extension origin", () => {
  beforeEach(async () => {
    page = await openPanel();
  });

  it("loads without script errors", async () => {
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it("populates every control from the bridge's settings", async () => {
    expect(await page.inputValue("#host")).toBe("127.0.0.1");
    expect(await page.inputValue("#port")).toBe("3025");
    expect(await page.inputValue("#captureMode")).toBe("debugger");
    expect(await page.inputValue("#logLimit")).toBe("50");
    expect(await page.inputValue("#queryLimit")).toBe("30000");
    expect(await page.inputValue("#stringSizeLimit")).toBe("500");

    expect(await page.isChecked("#captureConsole")).toBe(true);
    expect(await page.isChecked("#captureNetwork")).toBe(true);
    // Deliberately differing defaults, to prove values are read not assumed.
    expect(await page.isChecked("#captureResponseBodies")).toBe(false);
    expect(await page.isChecked("#showRequestHeaders")).toBe(false);
    expect(await page.isChecked("#showResponseHeaders")).toBe(true);

    await page.close();
  });

  it("renders each connection state distinctly", async () => {
    // The initial state comes from the bridge's getStatus().
    expect(await page.getAttribute("#dot", "class")).toContain("connecting");

    await page.evaluate(() =>
      (window as any).__pushStatus({ state: "connected", server: "127.0.0.1:3025", detail: "" })
    );
    expect(await page.getAttribute("#dot", "class")).toContain("connected");
    expect(await page.textContent("#state")).toContain("Connected");
    expect(await page.textContent("#server")).toContain("127.0.0.1:3025");

    await page.evaluate(() =>
      (window as any).__pushStatus({
        state: "disconnected",
        server: null,
        detail: "No connector found on localhost.",
      })
    );
    expect(await page.getAttribute("#dot", "class")).toContain("disconnected");
    expect(await page.textContent("#state")).toContain("Not connected");
    expect(await page.textContent("#detail")).toContain("No connector found");

    await page.close();
  });

  it("saves edited connection settings through the bridge", async () => {
    await page.fill("#host", "localhost");
    await page.fill("#port", "3031");
    await page.click("#save");

    const calls = (await page.evaluate(() => (window as any).__calls)) as any[];
    const saved = calls.find((c) => c[0] === "updateSettings");

    expect(saved).toBeTruthy();
    expect(saved[1].serverHost).toBe("localhost");
    expect(saved[1].serverPort).toBe(3031);
    expect(await page.textContent("#detail")).toContain("saved");

    await page.close();
  });

  it("applies a checkbox change immediately, without needing Save", async () => {
    await page.click("#showRequestHeaders");

    const calls = (await page.evaluate(() => (window as any).__calls)) as any[];
    const last = calls.filter((c) => c[0] === "updateSettings").at(-1);

    expect(last[1].showRequestHeaders).toBe(true);
    await page.close();
  });

  it("applies a capture-mode change immediately", async () => {
    await page.selectOption("#captureMode", "inject");

    const calls = (await page.evaluate(() => (window as any).__calls)) as any[];
    const last = calls.filter((c) => c[0] === "updateSettings").at(-1);

    expect(last[1].captureMode).toBe("inject");
    await page.close();
  });

  it("sends every settings field on each update, not just the changed one", async () => {
    await page.click("#captureNetwork");

    const calls = (await page.evaluate(() => (window as any).__calls)) as any[];
    const last = calls.filter((c) => c[0] === "updateSettings").at(-1);

    // A partial payload would silently reset whatever it omitted.
    expect(Object.keys(last[1]).sort()).toEqual(
      [
        "captureConsole",
        "captureMode",
        "captureNetwork",
        "captureResponseBodies",
        "logLimit",
        "queryLimit",
        "serverHost",
        "serverPort",
        "showRequestHeaders",
        "showResponseHeaders",
        "stringSizeLimit",
      ].sort()
    );

    await page.close();
  });

  it("falls back to sane values when a numeric field is cleared", async () => {
    await page.fill("#port", "");
    await page.fill("#logLimit", "");
    await page.click("#save");

    const calls = (await page.evaluate(() => (window as any).__calls)) as any[];
    const saved = calls.filter((c) => c[0] === "updateSettings").at(-1);

    expect(saved[1].serverPort).toBe(3025);
    expect(saved[1].logLimit).toBeGreaterThan(0);
    await page.close();
  });

  it("falls back to loopback when the host is cleared", async () => {
    await page.fill("#host", "   ");
    await page.click("#save");

    const calls = (await page.evaluate(() => (window as any).__calls)) as any[];
    const saved = calls.filter((c) => c[0] === "updateSettings").at(-1);

    expect(saved[1].serverHost).toBe("127.0.0.1");
    await page.close();
  });

  it("triggers a reconnect from the button", async () => {
    await page.click("#reconnect");
    const calls = (await page.evaluate(() => (window as any).__calls)) as any[];
    expect(calls.some((c) => c[0] === "reconnect")).toBe(true);
    await page.close();
  });

  it("reports the outcome of a cookie permission request", async () => {
    await page.click("#cookies");
    await page.waitForFunction(() =>
      (document.getElementById("detail")?.textContent ?? "").length > 0
    );
    expect(await page.textContent("#detail")).toContain("granted");

    await page.evaluate(() => ((window as any).__cookieGrant = false));
    await page.click("#cookies");
    await page.waitForFunction(() =>
      (document.getElementById("detail")?.textContent ?? "").includes("declined")
    );
    expect(await page.textContent("#detail")).toContain("declined");

    await page.close();
  });

  it("never reports an error while being driven", async () => {
    await page.click("#save");
    await page.click("#reconnect");
    await page.selectOption("#captureMode", "inject");
    await page.click("#captureConsole");

    expect(pageErrors).toEqual([]);
    await page.close();
  });
});

describe.skipIf(!browserSupport.usable)("panel UI without a bridge", () => {
  it("explains itself instead of hanging silently", async () => {
    const panel = await context!.newPage();
    const errors: string[] = [];
    panel.on("pageerror", (error) => errors.push(error.message));

    // No stub: reproduces the panel loading without the devtools page behind it.
    await panel.goto(`chrome-extension://${extensionId}/panel.html`, {
      waitUntil: "domcontentloaded",
    });

    await panel.waitForFunction(
      () => (document.getElementById("state")?.textContent ?? "").includes("could not reach"),
      undefined,
      { timeout: 15_000 }
    );

    expect(await panel.textContent("#detail")).toContain("reopen DevTools");
    expect(errors).toEqual([]);
    await panel.close();
  }, 60_000);
});

describe.skipIf(!browserSupport.usable)("panel and devtools page agree on the bridge contract", () => {
  const read = (file: string) =>
    fs.readFileSync(path.join(extensionPath, file), "utf8");

  it("devtools.js defines every method panel.js calls", () => {
    const panelSource = read("panel.js");
    const devtoolsSource = read("devtools.js");

    const called = new Set(
      [...panelSource.matchAll(/\bbridge\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!)
    );
    expect(called.size).toBeGreaterThan(3);

    // The object literal assigned to panelWindow.btmcp in devtools.js.
    const start = devtoolsSource.indexOf("panelWindow.btmcp = {");
    expect(start).toBeGreaterThan(-1);
    const bridgeBlock = devtoolsSource.slice(start, devtoolsSource.indexOf("\n    });", start));

    for (const method of called) {
      expect(
        new RegExp(`(^|[\\s{,])(async\\s+)?${method}\\s*[(:]`, "m").test(bridgeBlock),
        `devtools.js must provide bridge.${method}`
      ).toBe(true);
    }
  });

  it("every element panel.js looks up exists in panel.html", () => {
    const panelSource = read("panel.js");
    const markup = read("panel.html");

    const ids = new Set(
      [...panelSource.matchAll(/\bel\("([^"]+)"\)/g)].map((m) => m[1]!)
    );
    // Names come from the arrays panel.js iterates, so pick those up too.
    for (const list of panelSource.matchAll(/const (?:CHECKBOXES|NUMBERS) = \[([^\]]+)\]/g)) {
      for (const entry of list[1]!.matchAll(/"([^"]+)"/g)) ids.add(entry[1]!);
    }

    expect(ids.size).toBeGreaterThan(8);
    for (const id of ids) {
      expect(markup.includes(`id="${id}"`), `panel.html is missing id="${id}"`).toBe(true);
    }
  });
});
