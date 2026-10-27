import { describe, it, expect } from "vitest";
import { helpText, parseCli } from "../../src/cli";
import {
  decideCapability,
  defaultGatePolicy,
  GateReason,
  NO_DEVTOOLS_ACTIONS,
  PANEL_ACTIONS,
  tabListed,
  type GateContext,
  type GatePolicy,
} from "../../src/gates/capability";

function policy(overrides: Partial<GatePolicy> = {}): GatePolicy {
  return { ...defaultGatePolicy(), ...overrides };
}

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    policy: policy(),
    popupEnabled: false,
    panelEnabled: false,
    liveUrl: null,
    destinationUrl: null,
    ...overrides,
  };
}

describe("capability flags", () => {
  it("stay off when the environment tries to enable them", () => {
    const options = parseCli([], {
      BROWSER_TOOLS_ALLOW_EVAL: "true",
      BROWSER_TOOLS_ALLOW_INPUT: "1",
      BROWSER_TOOLS_ALLOW_INPUT_ORIGINS: "https://example.com",
      BROWSER_TOOLS_EXCLUDE_ORIGINS: "https://example.com",
    });
    expect(options.allowEval).toBe(false);
    expect(options.allowInput).toBe(false);
    expect(options.allowInputOrigins).toBeUndefined();
    expect(options.excludeOrigins).toBeUndefined();
  });

  it("turn on only from argv", () => {
    const options = parseCli(
      [
        "--allow-eval",
        "--allow-input",
        "--allow-input-origins",
        "https://example.com,https://other.example",
        "--exclude-origins=http://localhost:3000",
      ],
      { BROWSER_TOOLS_ALLOW_INPUT: "true" }
    );
    expect(options.allowEval).toBe(true);
    expect(options.allowInput).toBe(true);
    expect(options.allowInputOrigins).toEqual(["https://example.com", "https://other.example"]);
    expect(options.excludeOrigins).toEqual(["http://localhost:3000"]);
  });

  it("does not treat a banner-hiding flag as a capability", () => {
    const options = parseCli(["--silent-debugger-extension-api"], {});
    expect(options.allowEval).toBe(false);
    expect(options.allowInput).toBe(false);
    expect(options).not.toHaveProperty("bannerBypass");
    expect(helpText()).not.toContain("silent-debugger");
    expect(helpText()).toContain("No environment variable");
  });
});

describe("no-DevTools actions", () => {
  it("refuses each one while the popup switch is off", () => {
    for (const action of NO_DEVTOOLS_ACTIONS) {
      const decision = decideCapability(
        action,
        context({
          popupEnabled: false,
          policy: policy({ allowInput: true, allowEval: true }),
          liveUrl: "http://localhost:3000/",
          destinationUrl: "http://localhost:3000/",
        })
      );
      expect(decision, action).toEqual({ allowed: false, reason: GateReason.popupOff });
    }
  });

  it("still refuses navigation and soft input when the process flag is off", () => {
    for (const action of ["navigate", "softClick", "softType"] as const) {
      const decision = decideCapability(
        action,
        context({
          popupEnabled: true,
          policy: policy({ allowInput: false }),
          liveUrl: "http://localhost:3000/",
          destinationUrl: "http://127.0.0.1:3000/",
        })
      );
      expect(decision, action).toEqual({ allowed: false, reason: GateReason.inputOff });
    }
  });

  it("allows the tab list and a public read when the popup is on, and not navigation", () => {
    const shared = context({
      popupEnabled: true,
      policy: policy({ allowInput: false }),
      liveUrl: "https://example.com/inbox",
    });
    expect(decideCapability("listTabs", shared).allowed).toBe(true);
    expect(decideCapability("readTab", shared)).toEqual({ allowed: true, reason: GateReason.allowed });
    expect(decideCapability("navigate", { ...shared, destinationUrl: "https://example.com/next" })).toEqual({
      allowed: false,
      reason: GateReason.inputOff,
    });
  });
});

describe("panel actions", () => {
  it("refuses each one while the panel switch is off", () => {
    for (const action of PANEL_ACTIONS) {
      const decision = decideCapability(
        action,
        context({
          panelEnabled: false,
          popupEnabled: true,
          policy: policy({ allowInput: true, allowEval: true }),
          liveUrl: "http://localhost:3000/",
        })
      );
      expect(decision, action).toEqual({ allowed: false, reason: GateReason.panelOff });
    }
  });

  it("keeps real input and the debugger fallback behind --allow-input", () => {
    for (const action of ["click", "type", "pressKey", "debuggerFallback"] as const) {
      expect(
        decideCapability(
          action,
          context({
            panelEnabled: true,
            policy: policy({ allowInput: false }),
            liveUrl: "http://localhost:3000/",
          })
        )
      ).toEqual({ allowed: false, reason: GateReason.inputOff });
    }
  });

  it("keeps script evaluation behind --allow-eval", () => {
    expect(
      decideCapability(
        "evaluateScript",
        context({
          panelEnabled: true,
          policy: policy({ allowEval: false, allowInput: true }),
          liveUrl: "http://localhost:3000/",
        })
      )
    ).toEqual({ allowed: false, reason: GateReason.evalOff });
  });

  it("refuses a banner bypass even when every other switch is on", () => {
    expect(
      decideCapability(
        "debuggerFallback",
        context({
          hideBanner: true,
          panelEnabled: true,
          popupEnabled: true,
          policy: policy({ allowInput: true, allowEval: true, inputOrigins: ["https://example.com"] }),
          liveUrl: "http://localhost:3000/",
        })
      )
    ).toEqual({ allowed: false, reason: GateReason.banner });
  });
});

describe("origin allowlist", () => {
  const open = context({
    popupEnabled: true,
    panelEnabled: true,
    policy: policy({ allowInput: true, allowEval: true }),
  });

  it("checks only the destination when opening a new background tab", () => {
    expect(
      decideCapability("navigate", {
        ...open,
        creatingTab: true,
        liveUrl: null,
        destinationUrl: "http://127.0.0.1:3000/next",
      })
    ).toEqual({ allowed: true, reason: GateReason.allowed });
    expect(
      decideCapability("navigate", {
        ...open,
        creatingTab: true,
        destinationUrl: "https://example.com/",
      })
    ).toEqual({ allowed: false, reason: GateReason.destinationNotAllowed });
    expect(
      decideCapability("navigate", {
        ...open,
        creatingTab: true,
        liveUrl: null,
        destinationUrl: null,
      })
    ).toEqual({ allowed: false, reason: GateReason.destinationMissing });
  });

  it("refuses a restricted destination when opening a new background tab", () => {
    expect(
      decideCapability("navigate", {
        ...open,
        creatingTab: true,
        liveUrl: null,
        destinationUrl: "chrome://settings",
      })
    ).toEqual({ allowed: false, reason: GateReason.restricted });
    expect(
      decideCapability("navigate", {
        ...open,
        creatingTab: true,
        destinationUrl: "https://chromewebstore.google.com/detail/ext",
      })
    ).toEqual({ allowed: false, reason: GateReason.restricted });
    expect(
      decideCapability("navigate", {
        ...open,
        creatingTab: true,
        destinationUrl: "http://localhost:3000/manual.pdf",
      }).allowed
    ).toBe(true);
  });

  it("allows local addresses by default and refuses a public origin until it is listed", () => {
    expect(
      decideCapability("softClick", { ...open, liveUrl: "http://localhost:3000/app" }).allowed
    ).toBe(true);
    expect(decideCapability("click", { ...open, liveUrl: "http://127.0.0.1:3000/" }).allowed).toBe(true);
    expect(decideCapability("type", { ...open, liveUrl: "http://[::1]:3000/" }).allowed).toBe(true);
    expect(decideCapability("pressKey", { ...open, liveUrl: "http://10.1.2.3/" }).allowed).toBe(true);
    expect(decideCapability("navigate", { ...open, liveUrl: "http://dev.local/", destinationUrl: "http://dev.local/next" }).allowed).toBe(true);

    expect(decideCapability("softType", { ...open, liveUrl: "https://example.com/" })).toEqual({
      allowed: false,
      reason: GateReason.urlNotAllowed,
    });
    expect(
      decideCapability("softType", {
        ...open,
        policy: policy({ allowInput: true, inputOrigins: ["https://example.com"] }),
        liveUrl: "https://example.com/path",
      }).allowed
    ).toBe(true);
  });

  it("holds navigate to the same list for the current tab and the destination", () => {
    expect(
      decideCapability("navigate", {
        ...open,
        liveUrl: "http://localhost:3000/",
        destinationUrl: "https://example.com/",
      })
    ).toEqual({ allowed: false, reason: GateReason.destinationNotAllowed });

    expect(
      decideCapability("navigate", {
        ...open,
        liveUrl: "https://example.com/",
        destinationUrl: "http://localhost:3000/",
      })
    ).toEqual({ allowed: false, reason: GateReason.urlNotAllowed });

    expect(
      decideCapability("navigate", {
        ...open,
        liveUrl: "http://localhost:3000/",
        destinationUrl: null,
      })
    ).toEqual({ allowed: false, reason: GateReason.destinationMissing });
  });

  it("refuses a missing live URL and an excluded origin even when that origin is local or listed", () => {
    expect(decideCapability("softClick", { ...open, liveUrl: null })).toEqual({
      allowed: false,
      reason: GateReason.urlMissing,
    });
    expect(decideCapability("readTab", { ...open, liveUrl: "" })).toEqual({
      allowed: false,
      reason: GateReason.urlMissing,
    });

    const excluded = policy({
      allowInput: true,
      inputOrigins: ["https://example.com"],
      excludeOrigins: ["http://localhost:3000", "https://example.com"],
    });
    expect(
      decideCapability("click", { ...open, policy: excluded, liveUrl: "http://localhost:3000/secret" })
    ).toEqual({ allowed: false, reason: GateReason.excluded });
    expect(
      decideCapability("readTab", { ...open, policy: excluded, liveUrl: "https://example.com/mail" })
    ).toEqual({ allowed: false, reason: GateReason.excluded });
  });

  it("refuses blocked and fake-ip addresses even when they are listed", () => {
    const listed = policy({
      allowInput: true,
      inputOrigins: ["http://169.254.169.254", "http://198.18.0.5", "http://metadata.google.internal"],
    });
    for (const liveUrl of ["http://169.254.169.254/", "http://198.18.0.5/", "http://metadata.google.internal/"]) {
      expect(decideCapability("softClick", { ...open, policy: listed, liveUrl }), liveUrl).toEqual({
        allowed: false,
        reason: GateReason.urlNotAllowed,
      });
      expect(decideCapability("readTab", { ...open, policy: listed, liveUrl }), liveUrl).toEqual({
        allowed: false,
        reason: GateReason.urlNotAllowed,
      });
    }
  });

  it("refuses a non-scriptable page and a URL that carries credentials", () => {
    expect(decideCapability("readTab", { ...open, liveUrl: "chrome://settings" })).toEqual({
      allowed: false,
      reason: GateReason.restricted,
    });
    expect(decideCapability("click", { ...open, liveUrl: "http://user:pass@localhost:3000/" })).toEqual({
      allowed: false,
      reason: GateReason.urlNotAllowed,
    });
  });

  it("lets navigation leave a restricted page and still refuses acting on one", () => {
    expect(
      decideCapability("navigate", {
        ...open,
        liveUrl: "chrome://settings",
        destinationUrl: "http://localhost:3000/next",
      })
    ).toEqual({ allowed: true, reason: GateReason.allowed });

    expect(
      decideCapability("navigate", {
        ...open,
        liveUrl: "http://localhost:3000/",
        destinationUrl: "devtools://devtools/",
      })
    ).toEqual({ allowed: false, reason: GateReason.restricted });

    expect(
      decideCapability("navigate", {
        ...open,
        liveUrl: "chrome://newtab/",
        destinationUrl: "https://chromewebstore.google.com/detail/ext",
      })
    ).toEqual({ allowed: false, reason: GateReason.restricted });

    expect(
      decideCapability("navigate", {
        ...open,
        liveUrl: "http://localhost:3000/",
        destinationUrl: "http://localhost:3000/manual.pdf",
      }).allowed
    ).toBe(true);

    expect(decideCapability("softClick", { ...open, liveUrl: "http://localhost:3000/manual.pdf" })).toEqual({
      allowed: false,
      reason: GateReason.restricted,
    });
    expect(
      decideCapability("readTab", { ...open, liveUrl: "https://chrome.google.com/webstore/detail/ext" })
    ).toEqual({ allowed: false, reason: GateReason.restricted });
    expect(tabListed("chrome://extensions/", policy())).toBe(true);
    expect(tabListed("about:blank", policy())).toBe(true);
  });

  it("drops excluded origins from a tab listing and leaves the list empty by default", () => {
    const exclude = policy({ excludeOrigins: ["https://excluded.example"] });
    expect(tabListed("https://excluded.example/inbox", exclude)).toBe(false);
    expect(tabListed("https://example.com/", exclude)).toBe(true);
    expect(tabListed("http://localhost:3000/", policy())).toBe(true);
    expect(tabListed("https://example.com/", policy())).toBe(true);
  });
});
