import { describe, expect, it } from "vitest";

import { defaultGatePolicy } from "../../src/gates/capability";
import { TAB_COVERAGE } from "../../src/tabs/contract";
import {
  normalizeChromeTabListing,
  parseChromeNavigate,
  parseSoftInput,
} from "../../src/tabs/listing";

describe("normalizeChromeTabListing", () => {
  it("drops incognito, excluded origins, and keeps chrome.tabs metadata", () => {
    const listing = normalizeChromeTabListing(
      {
        visibleWindowId: 1,
        windows: [
          {
            windowId: 1,
            focused: true,
            type: "normal",
            incognito: false,
            tabs: [
              {
                chromeTabId: 7,
                windowId: 1,
                title: "Local",
                url: "http://127.0.0.1:3000/app",
                active: true,
                pinned: false,
                discarded: true,
                frozen: false,
                lastAccessed: 100,
                audible: false,
                status: "complete",
                index: 0,
              },
              {
                chromeTabId: 8,
                windowId: 1,
                title: "Mail sess_abcdefghijklmnopqrstuvwxyz",
                url: "https://excluded.example/inbox?token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                active: false,
                discarded: false,
                frozen: true,
                lastAccessed: 50,
              },
            ],
          },
          {
            windowId: 2,
            focused: false,
            type: "normal",
            incognito: true,
            tabs: [{ chromeTabId: 9, windowId: 2, title: "Private", url: "https://example.com/", active: true }],
          },
        ],
      },
      { ...defaultGatePolicy(), excludeOrigins: ["https://excluded.example"] }
    );

    expect(listing.coverage).toBe(TAB_COVERAGE);
    expect(listing.visibleWindowId).toBe(1);
    expect(listing.windows).toHaveLength(1);
    expect(listing.windows[0]?.tabs).toHaveLength(1);
    expect(listing.windows[0]?.tabs[0]).toMatchObject({
      chromeTabId: 7,
      site: "http://127.0.0.1:3000",
      discarded: true,
      lastAccessed: 100,
      active: true,
    });
    expect(JSON.stringify(listing)).not.toContain("ghp_");
    expect(JSON.stringify(listing)).not.toContain("Private");
  });
});

describe("tab action results", () => {
  it("refuses a navigation that attached the debugger or changed focus", () => {
    expect(() =>
      parseChromeNavigate("http://127.0.0.1/", {
        chromeTabId: 3,
        visibleWindowId: 1,
        finalUrl: "http://127.0.0.1/",
        safety: { debuggerCalls: 1, focusChanges: 0 },
      })
    ).toThrow(/debugger or change focus/);
  });

  it("never reports a soft action as trusted", () => {
    expect(
      parseSoftInput(4, {
        outcome: "worked",
        reason: null,
        detail: "Value set",
        trusted: true,
        safety: { debuggerCalls: 0, focusChanges: 0 },
      })
    ).toEqual({
      chromeTabId: 4,
      outcome: "worked",
      reason: null,
      detail: "Value set",
      trusted: false,
    });

    expect(() =>
      parseSoftInput(4, {
        outcome: "needs a real gesture",
        reason: "made up",
        detail: "",
        safety: { debuggerCalls: 0, focusChanges: 0 },
      })
    ).toThrow(/without a reason/);
  });
});
