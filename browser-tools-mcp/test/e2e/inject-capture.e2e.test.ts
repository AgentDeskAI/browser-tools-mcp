import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { browserAvailability } from "../helpers/browser-available";
import { e2eChromiumOptions } from "../helpers/e2e-chromium";
import { chromium, type Browser, type Page } from "playwright";

import { startFixtureServer, type FixtureServer } from "../fixtures/server";

/**
 * The "wrap page console" capture mode, run against a real page.
 *
 * This is the fallback used wherever chrome.debugger is unavailable — notably
 * Firefox — and it is also what users switch to when they do not want Chrome's
 * "started debugging this browser" banner. The scripts under test are read
 * from the shipped extension file, not re-declared here, so this cannot drift
 * away from what actually runs.
 */

const sharedJsPath = path.resolve(
  fileURLToPath(new URL("../../../chrome-extension/shared.js", import.meta.url))
);

// Skips rather than fails where no browser can start — see the helper.
const browserSupport = await browserAvailability();
if (!browserSupport.usable) console.warn(`\n  SKIPPED: ${browserSupport.reason}\n`);

let INJECT_BOOTSTRAP: string;
let INJECT_DRAIN: string;
let browser: Browser;
let fixture: FixtureServer;

beforeAll(async () => {
  const source = fs.readFileSync(sharedJsPath, "utf8");
  // shared.js is a plain script of globals; evaluate it and take the two
  // injection strings back out.
  const extract = new Function(
    `${source}\nreturn { INJECT_BOOTSTRAP, INJECT_DRAIN };`
  ) as () => { INJECT_BOOTSTRAP: string; INJECT_DRAIN: string };
  ({ INJECT_BOOTSTRAP, INJECT_DRAIN } = extract());

  expect(INJECT_BOOTSTRAP).toContain("__btmcpBuffer");
  expect(INJECT_DRAIN).toContain("__btmcpBuffer");

  fixture = await startFixtureServer();
  // Headless unless HEADED=1. See e2e-chromium.ts.
  browser = await chromium.launch({
    ...browserSupport.launchOptions,
    ...e2eChromiumOptions(),
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await fixture?.close();
});

async function freshPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(fixture.url, { waitUntil: "load" });
  await page.evaluate(INJECT_BOOTSTRAP);
  return page;
}

describe.skipIf(!browserSupport.usable)("injected console capture", () => {
  it("installs without disturbing the page", async () => {
    const page = await freshPage();
    const installed = await page.evaluate("window.__btmcpInstalled");
    expect(installed).toBe(true);
    await page.close();
  });

  it("captures each console level", async () => {
    const page = await freshPage();
    await page.evaluate(() => {
      console.log("INJECT-LOG");
      console.info("INJECT-INFO");
      console.warn("INJECT-WARN");
      console.error("INJECT-ERROR");
      console.debug("INJECT-DEBUG");
    });

    const drained = (await page.evaluate(INJECT_DRAIN)) as Array<{
      level: string;
      message: string;
    }>;
    const byMessage = new Map(drained.map((e) => [e.message, e.level]));

    expect(byMessage.get("INJECT-LOG")).toBe("log");
    expect(byMessage.get("INJECT-INFO")).toBe("info");
    expect(byMessage.get("INJECT-WARN")).toBe("warn");
    expect(byMessage.get("INJECT-ERROR")).toBe("error");
    expect(byMessage.get("INJECT-DEBUG")).toBe("debug");

    await page.close();
  });

  it("still forwards output to the real console", async () => {
    const page = await browser.newPage();
    const seen: string[] = [];
    page.on("console", (message) => seen.push(message.text()));

    await page.goto(fixture.url, { waitUntil: "load" });
    await page.evaluate(INJECT_BOOTSTRAP);
    await page.evaluate(() => console.log("STILL-VISIBLE"));

    // Wrapping the console must not swallow the developer's own output.
    expect(seen.some((text) => text.includes("STILL-VISIBLE"))).toBe(true);
    await page.close();
  });

  it("serialises objects and multiple arguments", async () => {
    const page = await freshPage();
    await page.evaluate(() => {
      console.log("prefix", { a: 1, b: [2, 3] }, 42);
    });

    const drained = (await page.evaluate(INJECT_DRAIN)) as Array<{ message: string }>;
    const entry = drained.find((e) => e.message.startsWith("prefix"))!;

    expect(entry.message).toContain('{"a":1,"b":[2,3]}');
    expect(entry.message).toContain("42");
    await page.close();
  });

  it("survives values that cannot be serialised", async () => {
    const page = await freshPage();
    await page.evaluate(() => {
      const circular: any = { name: "loop" };
      circular.self = circular;
      console.log("CIRCULAR", circular);
      console.log("SYMBOLIC", Symbol("nope"));
    });

    const drained = (await page.evaluate(INJECT_DRAIN)) as Array<{ message: string }>;
    expect(drained.some((e) => e.message.includes("CIRCULAR"))).toBe(true);
    expect(drained.some((e) => e.message.includes("SYMBOLIC"))).toBe(true);
    await page.close();
  });

  it("captures uncaught errors and unhandled rejections", async () => {
    const page = await freshPage();

    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("INJECT-UNCAUGHT");
      }, 0);
      Promise.reject(new Error("INJECT-REJECTED"));
    });
    await page.waitForTimeout(300);

    const drained = (await page.evaluate(INJECT_DRAIN)) as Array<{
      level: string;
      message: string;
    }>;

    expect(drained.some((e) => e.message.includes("INJECT-UNCAUGHT"))).toBe(true);
    expect(drained.some((e) => e.message.includes("INJECT-REJECTED"))).toBe(true);
    // The fixture page also logs after load (fetches, a late timer). Those can
    // land in the buffer during the wait and are not part of this assertion.
    expect(
      drained
        .filter(
          (e) => e.message.includes("INJECT-UNCAUGHT") || e.message.includes("INJECT-REJECTED")
        )
        .every((e) => e.level === "error")
    ).toBe(true);
    await page.close();
  });

  it("empties the buffer on drain so entries are not sent twice", async () => {
    const page = await freshPage();
    await page.evaluate(() => console.log("ONCE-ONLY"));

    const first = (await page.evaluate(INJECT_DRAIN)) as unknown[];
    const second = (await page.evaluate(INJECT_DRAIN)) as unknown[];

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
    await page.close();
  });

  it("is idempotent, so re-injection does not double-wrap", async () => {
    const page = await freshPage();
    await page.evaluate(INJECT_BOOTSTRAP);
    await page.evaluate(INJECT_BOOTSTRAP);
    await page.evaluate(() => console.log("SINGLE-ENTRY"));

    const drained = (await page.evaluate(INJECT_DRAIN)) as Array<{ message: string }>;
    expect(drained.filter((e) => e.message === "SINGLE-ENTRY")).toHaveLength(1);
    await page.close();
  });

  it("caps the buffer so a noisy page cannot grow it without bound", async () => {
    const page = await freshPage();
    await page.evaluate(() => {
      for (let i = 0; i < 2000; i++) console.log(`flood-${i}`);
    });

    const drained = (await page.evaluate(INJECT_DRAIN)) as unknown[];
    expect(drained.length).toBeLessThanOrEqual(500);
    await page.close();
  });

  it("returns an empty list when nothing has been captured", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.url, { waitUntil: "load" });
    // Drain before bootstrap — must not throw.
    expect(await page.evaluate(INJECT_DRAIN)).toEqual([]);
    await page.close();
  });
});
