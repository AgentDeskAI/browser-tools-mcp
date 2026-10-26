import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright";
import { browserAvailability } from "../helpers/browser-available";
import { e2eChromiumOptions, wantsHeadedBrowser } from "../helpers/e2e-chromium";

/**
 * Proves the default launch really is Chrome's new headless mode and that
 * this mode still installs the extension. A regression back to Playwright's
 * chrome-headless-shell, or back to a visible window, fails here.
 *
 * DevTools stays closed. Opening it would run the extension's devtools page,
 * which connects to whatever connector is listening and can steal the current
 * tab from the other end-to-end file. That file is what exercises the
 * DevTools page itself.
 */

const browserSupport = await browserAvailability();
if (!browserSupport.usable) console.warn(`\n  SKIPPED: ${browserSupport.reason}\n`);

const extensionPath = path.resolve(
  fileURLToPath(new URL("../../../chrome-extension", import.meta.url))
);

let context: BrowserContext | null = null;
let userDataDir = "";

afterAll(async () => {
  await context?.close().catch(() => {});
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

/**
 * Chrome derives an unpacked extension's id from the SHA-256 of its absolute
 * path, mapping each nibble onto a-p. Same derivation as the panel suite.
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

function processCommandLines(): string[] {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
      ],
      { encoding: "utf8" }
    );
    return out.split(/\r?\n/);
  }
  return execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" }).split("\n");
}

describe.skipIf(!browserSupport.usable)("e2e browser launch mode", () => {
  it("loads the extension without a visible window unless HEADED=1", async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-launch-mode-"));
    context = await chromium.launchPersistentContext(userDataDir, {
      ...browserSupport.launchOptions,
      ...e2eChromiumOptions([
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ]),
    });

    // panel.html is a static extension page. Loading it does not start the
    // devtools page, so the extension does not dial the connector.
    const page = await context.newPage();
    const response = await page.goto(
      `chrome-extension://${unpackedExtensionId(extensionPath)}/panel.html`
    );
    expect(response?.status(), "extension did not load").toBeLessThan(400);

    const browserLine = processCommandLines().find(
      (line) => line.includes(userDataDir) && !line.includes("--type=")
    );
    expect(browserLine, "browser process command line").toBeTruthy();
    expect(browserLine).not.toContain("headless-shell");
    if (wantsHeadedBrowser()) {
      expect(browserLine).not.toContain("--headless");
    } else {
      expect(browserLine).toContain("--headless=new");
    }
  }, 60_000);
});
