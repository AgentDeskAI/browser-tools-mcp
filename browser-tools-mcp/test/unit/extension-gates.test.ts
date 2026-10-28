import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(fileURLToPath(new URL("../../../chrome-extension", import.meta.url)));

function loadGates(): {
  NO_DEVTOOLS_ACTIONS: string[];
  PANEL_ACTIONS: string[];
  confirmBeforeAct: (input: Record<string, unknown>) => { allowed: boolean; reason: string };
} {
  const context = { URL } as { URL: typeof URL; BTMCP_GATES: ReturnType<typeof loadGates> };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(extensionDir, "gates.js"), "utf8"), context);
  return context.BTMCP_GATES;
}

const gates = loadGates();

describe("extension confirmBeforeAct", () => {
  it("refuses each no-DevTools action while the popup switch is off", () => {
    for (const action of gates.NO_DEVTOOLS_ACTIONS) {
      expect(
        gates.confirmBeforeAct({
          action,
          popupEnabled: false,
          panelEnabled: true,
          approvedUrl: "http://localhost:3000/",
          liveUrl: "http://localhost:3000/",
        }),
        action
      ).toEqual({ allowed: false, reason: "popup switch is off" });
    }
  });

  it("refuses each panel action while the panel switch is off", () => {
    for (const action of gates.PANEL_ACTIONS) {
      expect(
        gates.confirmBeforeAct({
          action,
          popupEnabled: true,
          panelEnabled: false,
          approvedUrl: "http://localhost:3000/",
          liveUrl: "http://localhost:3000/",
        }),
        action
      ).toEqual({ allowed: false, reason: "panel switch is off" });
    }
  });

  it("refuses when the live origin is not the one that was approved", () => {
    expect(
      gates.confirmBeforeAct({
        action: "softClick",
        popupEnabled: true,
        panelEnabled: false,
        approvedUrl: "http://localhost:3000/app",
        liveUrl: "https://example.com/",
      })
    ).toEqual({ allowed: false, reason: "tab URL changed" });
  });

  it("refuses a banner bypass and a missing URL", () => {
    expect(
      gates.confirmBeforeAct({
        action: "debuggerFallback",
        popupEnabled: true,
        panelEnabled: true,
        hideBanner: true,
        approvedUrl: "http://localhost:3000/",
        liveUrl: "http://localhost:3000/",
      })
    ).toEqual({ allowed: false, reason: "banner bypass is disabled" });

    expect(
      gates.confirmBeforeAct({
        action: "navigate",
        popupEnabled: true,
        panelEnabled: false,
        approvedUrl: "http://localhost:3000/",
        liveUrl: null,
      })
    ).toEqual({ allowed: false, reason: "tab URL is missing" });
  });

  it("allows a new background tab without a live URL while the popup switch is on", () => {
    expect(
      gates.confirmBeforeAct({
        action: "navigate",
        popupEnabled: true,
        panelEnabled: false,
        creatingTab: true,
      })
    ).toEqual({ allowed: true, reason: "allowed" });
    expect(
      gates.confirmBeforeAct({
        action: "navigate",
        popupEnabled: false,
        panelEnabled: false,
        creatingTab: true,
      })
    ).toEqual({ allowed: false, reason: "popup switch is off" });
  });

  it("allows a list and a matching live origin only while the switch is on", () => {
    expect(
      gates.confirmBeforeAct({
        action: "listTabs",
        popupEnabled: true,
        panelEnabled: false,
      })
    ).toEqual({ allowed: true, reason: "allowed" });

    expect(
      gates.confirmBeforeAct({
        action: "softType",
        popupEnabled: true,
        panelEnabled: false,
        approvedUrl: "http://localhost:3000/a",
        liveUrl: "http://localhost:3000/b",
      })
    ).toEqual({ allowed: true, reason: "allowed" });
  });
});

describe("worker probe", () => {
  const worker = fs.readFileSync(path.join(extensionDir, "worker.js"), "utf8");
  const actions = fs.readFileSync(path.join(extensionDir, "tab-actions.js"), "utf8");
  const page = fs.readFileSync(path.join(extensionDir, "tab-page.js"), "utf8");
  const safety = fs.readFileSync(path.join(extensionDir, "tab-safety.js"), "utf8");

  it("reads tabs for probes and navigate without the debugger or focus changes", () => {
    expect(worker).toContain("tabs.get");
    expect(worker).toContain("navigate-tab");
    expect(worker).toContain("list-chrome-tabs");
    expect(worker).toContain("snapshot-chrome-tab");
    expect(worker).toContain("act-chrome-tab");
    expect(worker).not.toMatch(/chrome\.debugger|api\.debugger|\.attach\(/);
    expect(worker).not.toContain("windows.update");
    expect(worker).not.toContain("executeScript");
    expect(worker).not.toContain("silent-debugger");
    expect(worker).not.toMatch(/active\s*:\s*true/);
    expect(worker).not.toMatch(/focused\s*:\s*true/);
  });

  it("keeps chrome.tabs actions off the debugger and off focus changes", () => {
    const behavior = actions + page;
    expect(behavior).not.toMatch(/chrome\.debugger|api\.debugger/);
    expect(behavior).not.toMatch(/active\s*:\s*true/);
    expect(behavior).not.toMatch(/focused\s*:\s*true/);
    expect(behavior).not.toContain("silent-debugger");
    expect(behavior).not.toContain("--disable-features");
    expect(actions).toContain("active: false");
    expect(actions).toContain("visible window");
    expect(page).toContain("requestSubmit");
    expect(page).toContain("data-btmcp-ref");
    expect(page).toContain("btmcpSemanticSnapshot");
    expect(page).toContain("btmcpActOnRef");
    expect(page).not.toMatch(/computer[- ]use/i);
    expect(page).toContain("insertText");
    expect(page).toContain("needs a real gesture");
    expect(safety).toContain("Refusing to change focus.");
    expect(safety).not.toContain("silent-debugger");
  });
});
