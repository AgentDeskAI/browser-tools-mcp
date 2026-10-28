import { describe, expect, it } from "vitest";

import { defaultGatePolicy } from "../../src/gates/capability";
import { TAB_COVERAGE } from "../../src/tabs/contract";
import {
  normalizeChromeTabListing,
  parseActOnRef,
  parseChromeNavigate,
  parseSemanticSnapshot,
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

describe("semantic page map results", () => {
  it("keeps role, name, text, state, visibility, and a stable ref, and strips secrets", () => {
    const snapshot = parseSemanticSnapshot(4, {
      url: "http://127.0.0.1:3000/map?token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      title: "Map",
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
          state: { pressed: false },
          visible: true,
          depth: 1,
        },
        {
          ref: "e2",
          role: "checkbox",
          name: "Agree",
          text: "",
          state: { checked: true, disabled: false },
          visible: false,
          depth: 2,
        },
        { ref: "not-a-ref", role: "button", name: "skip", text: "", state: {}, visible: true, depth: 1 },
      ],
    });
    expect(snapshot.chromeTabId).toBe(4);
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.nodes[0]).toMatchObject({
      ref: "e1",
      role: "button",
      name: "Run check",
      visible: true,
      state: { pressed: false },
    });
    expect(snapshot.nodes[1]?.state).toEqual({ checked: true });
    expect(JSON.stringify(snapshot)).not.toContain("ghp_");
  });

  it("returns the what-changed delta and refuses a focus change", () => {
    expect(
      parseActOnRef(4, "e1", {
        outcome: "worked",
        reason: null,
        detail: "Untrusted click was delivered to the element.",
        trusted: true,
        delta: {
          urlChanged: false,
          previousUrl: "http://127.0.0.1:3000/map",
          url: "http://127.0.0.1:3000/map?changed=1",
          consoleErrors: ["MARKER-MAP-ERROR", ""],
          failedRequests: [{ url: "http://127.0.0.1:3000/api/fail", status: 500 }, { url: "/api/down", status: 0 }],
        },
        safety: { debuggerCalls: 0, focusChanges: 0 },
      })
    ).toEqual({
      chromeTabId: 4,
      ref: "e1",
      outcome: "worked",
      reason: null,
      detail: "Untrusted click was delivered to the element.",
      trusted: false,
      delta: {
        urlChanged: true,
        previousUrl: "http://127.0.0.1:3000/map",
        url: "http://127.0.0.1:3000/map?changed=1",
        consoleErrors: ["MARKER-MAP-ERROR"],
        failedRequests: [
          { url: "http://127.0.0.1:3000/api/fail", status: 500 },
          { url: "/api/down", status: null },
        ],
      },
    });

    expect(() =>
      parseActOnRef(4, "e1", {
        outcome: "worked",
        detail: "",
        delta: { previousUrl: "http://127.0.0.1/", url: "http://127.0.0.1/" },
        safety: { debuggerCalls: 0, focusChanges: 1 },
      })
    ).toThrow(/change focus/);

    expect(() =>
      parseActOnRef(4, "e1", {
        outcome: "worked",
        detail: "",
        safety: { debuggerCalls: 0, focusChanges: 0 },
      })
    ).toThrow(/what changed/);
  });
});
