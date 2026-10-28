import { describe, expect, it } from "vitest";

import {
  CHROME_TAB_ID,
  DEVTOOLS_TAB_ID,
  GESTURE_REASONS,
  LIST_TABS_DESCRIPTION,
  NAVIGATE_TAB_DESCRIPTION,
  READ_TAB_DESCRIPTION,
  ACT_ON_REF_DESCRIPTION,
  SNAPSHOT_TAB_DESCRIPTION,
  SOFT_CLICK_DESCRIPTION,
  SOFT_TYPE_DESCRIPTION,
  TAB_COVERAGE,
  TAB_TOOL_NAMES,
} from "../../src/tabs/contract";
import {
  DEVTOOLS_TAB_INPUT,
  LIST_BROWSER_TABS_DESCRIPTION,
  NAVIGATE_BROWSER_DESCRIPTION,
} from "../../src/tabs/contract";

describe("tab id contract", () => {
  it("keeps DevTools-connected ids and chrome.tabs ids in separate sentences", () => {
    expect(DEVTOOLS_TAB_ID).toMatch(/listBrowserTabs/);
    expect(DEVTOOLS_TAB_ID).toMatch(/Not a chromeTabId/);
    expect(CHROME_TAB_ID).toMatch(/listTabs/);
    expect(CHROME_TAB_ID).toMatch(/Not a DevTools-connected tabId/);
    expect(DEVTOOLS_TAB_INPUT).toMatch(/Not a chromeTabId/);
  });

  it("does not claim listBrowserTabs is every open tab", () => {
    expect(LIST_BROWSER_TABS_DESCRIPTION).toMatch(/not every open tab/);
    expect(LIST_BROWSER_TABS_DESCRIPTION).toMatch(/not chromeTabId/);
  });

  it("describes navigateBrowser as the DevTools-connected path", () => {
    expect(NAVIGATE_BROWSER_DESCRIPTION).toMatch(/listBrowserTabs/);
    expect(NAVIGATE_BROWSER_DESCRIPTION).toMatch(/not a chromeTabId/);
    expect(NAVIGATE_BROWSER_DESCRIPTION).not.toMatch(/silent-debugger/);
    expect(NAVIGATE_BROWSER_DESCRIPTION).toMatch(/active:true/);
    expect(NAVIGATE_BROWSER_DESCRIPTION).toMatch(/focused:true/);
  });
});

describe("chrome.tabs tool descriptions", () => {
  it("uses the measured coverage sentence and does not say every open tab", () => {
    expect(TAB_COVERAGE).toBe(
      "Tabs the browser exposes through chrome.tabs in the windows it returns. " +
        "Other Arc Spaces, Little Arc, pinned favorites, split-view partners, and slept tabs may be missing. " +
        "Incognito is skipped. This is not every open tab."
    );
    expect(LIST_TABS_DESCRIPTION.startsWith(TAB_COVERAGE)).toBe(true);
    expect(LIST_TABS_DESCRIPTION).toMatch(/This is not every open tab/);
    expect(LIST_TABS_DESCRIPTION).not.toMatch(/every tab you have|all open tabs|see every/i);
    for (const text of [
      READ_TAB_DESCRIPTION,
      SNAPSHOT_TAB_DESCRIPTION,
      NAVIGATE_TAB_DESCRIPTION,
      SOFT_CLICK_DESCRIPTION,
      SOFT_TYPE_DESCRIPTION,
      ACT_ON_REF_DESCRIPTION,
    ]) {
      expect(text).toMatch(/chromeTabId/);
      expect(text).toMatch(/not a DevTools-connected tabId/);
      expect(text).not.toMatch(/every open tab/i);
      expect(text).not.toMatch(/silent-debugger/);
    }
  });

  it("keeps background navigate inside the visible window and gated like input", () => {
    expect(NAVIGATE_TAB_DESCRIPTION).toMatch(/visible window/);
    expect(NAVIGATE_TAB_DESCRIPTION).toMatch(/--allow-input/);
    expect(NAVIGATE_TAB_DESCRIPTION).toMatch(/wasDiscarded/);
    expect(NAVIGATE_TAB_DESCRIPTION).not.toMatch(/active:\s*true/);
  });

  it("names both soft-input outcomes and the gesture reasons", () => {
    expect(SOFT_CLICK_DESCRIPTION).toMatch(/"worked"/);
    expect(SOFT_TYPE_DESCRIPTION).toMatch(/"needs a real gesture"/);
    expect(SOFT_TYPE_DESCRIPTION).toMatch(/native value setter/);
    expect(SOFT_TYPE_DESCRIPTION).toMatch(/insertText/);
    expect(SOFT_CLICK_DESCRIPTION).toMatch(/requestSubmit/);
    for (const reason of GESTURE_REASONS) {
      expect(SOFT_CLICK_DESCRIPTION).toContain(reason);
    }
  });

  it("describes the page map and the what-changed delta without calling it computer use", () => {
    expect(SNAPSHOT_TAB_DESCRIPTION).toMatch(/accessible name/);
    expect(SNAPSHOT_TAB_DESCRIPTION).toMatch(/stable ref/);
    expect(SNAPSHOT_TAB_DESCRIPTION).toMatch(/visibility/);
    expect(SNAPSHOT_TAB_DESCRIPTION).toMatch(/does not change focus/i);
    expect(ACT_ON_REF_DESCRIPTION).toMatch(/snapshotTab/);
    expect(ACT_ON_REF_DESCRIPTION).toMatch(/softClick/);
    expect(ACT_ON_REF_DESCRIPTION).toMatch(/console errors/);
    expect(ACT_ON_REF_DESCRIPTION).toMatch(/failed after the action/);
    expect(ACT_ON_REF_DESCRIPTION).toMatch(/--allow-input/);
    for (const text of [SNAPSHOT_TAB_DESCRIPTION, ACT_ON_REF_DESCRIPTION]) {
      expect(text).not.toMatch(/computer[- ]use/i);
      expect(text).not.toMatch(/chrome\.debugger/);
    }
  });

  it("lists the chrome.tabs tools separately from listBrowserTabs", () => {
    expect([...TAB_TOOL_NAMES]).toEqual([
      "listTabs",
      "readTab",
      "snapshotTab",
      "navigateTab",
      "softClick",
      "softType",
      "actOnRef",
    ]);
    expect(TAB_TOOL_NAMES).not.toContain("listBrowserTabs");
    expect(TAB_TOOL_NAMES).not.toContain("navigateBrowser");
  });
});
