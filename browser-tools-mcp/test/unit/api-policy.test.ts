import { describe, it, expect } from "vitest";
import { ALL_TOOL_NAMES } from "../../src/mcp/server";
import {
  API_TOOL_NAMES,
  decideApiAccess,
  resolveEnabledTools,
} from "../../src/connector/api-policy";

describe("resolveEnabledTools", () => {
  const all = ["getConsoleLogs", "wipeLogs", "refreshBrowser"];

  it("starts from every tool, then removes exclusions", () => {
    const { enabled, unknown } = resolveEnabledTools(all, undefined, ["wipeLogs"]);
    expect([...enabled].sort()).toEqual(["getConsoleLogs", "refreshBrowser"]);
    expect(unknown).toEqual([]);
  });

  it("treats an empty allowlist as no tools, and ignores unknown names", () => {
    const none = resolveEnabledTools(all, [], undefined);
    expect(none.enabled.size).toBe(0);

    const { enabled, unknown } = resolveEnabledTools(all, ["getConsoleLogs", "noSuchTool"], ["getConsoleLogs"]);
    expect([...enabled]).toEqual([]);
    expect(unknown).toEqual(["noSuchTool"]);
  });
});

describe("decideApiAccess", () => {
  const enabled = new Set(API_TOOL_NAMES);

  it("covers every MCP tool, so a new tool cannot skip the local API filter", () => {
    expect(new Set(API_TOOL_NAMES)).toEqual(new Set(ALL_TOOL_NAMES));
  });

  it("refuses a state-changing call until actions are allowed", () => {
    const refused = decideApiAccess({
      method: "POST",
      path: "/screenshot",
      query: {},
      enabled,
      actionsAllowed: false,
    });
    expect(refused).toMatchObject({ ok: false, code: "ACTION_NOT_CONFIRMED" });

    const allowed = decideApiAccess({
      method: "POST",
      path: "/screenshot",
      query: {},
      enabled,
      actionsAllowed: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it("does not let a confirmation re-enable a tool that was excluded", () => {
    const withoutWipe = new Set([...enabled].filter((name) => name !== "wipeLogs"));
    const decision = decideApiAccess({
      method: "POST",
      path: "/wipe",
      query: {},
      enabled: withoutWipe,
      actionsAllowed: true,
    });
    expect(decision).toMatchObject({ ok: false, code: "TOOL_DISABLED" });
  });

  it("maps an audit artifact back to the one audit tool", () => {
    const onlySeo = new Set(["runSEOAudit"]);
    expect(
      decideApiAccess({
        method: "GET",
        path: "/artifact/audit/seo-1-ab.json",
        query: {},
        enabled: onlySeo,
        actionsAllowed: false,
      }).ok
    ).toBe(true);
    expect(
      decideApiAccess({
        method: "GET",
        path: "/artifact/audit/best-practices-1-ab.json",
        query: {},
        enabled: onlySeo,
        actionsAllowed: false,
      }).code
    ).toBe("TOOL_DISABLED");
  });

  it("treats a page-map read as a tool and an action on a ref as state-changing", () => {
    expect(
      decideApiAccess({
        method: "POST",
        path: "/chrome-tabs/snapshot",
        query: {},
        enabled,
        actionsAllowed: false,
      }).ok
    ).toBe(true);
    expect(
      decideApiAccess({
        method: "POST",
        path: "/chrome-tabs/act",
        query: {},
        enabled,
        actionsAllowed: false,
      }).code
    ).toBe("ACTION_NOT_CONFIRMED");
    const withoutAct = new Set([...enabled].filter((name) => name !== "actOnRef"));
    expect(
      decideApiAccess({
        method: "POST",
        path: "/chrome-tabs/act",
        query: {},
        enabled: withoutAct,
        actionsAllowed: true,
      }).code
    ).toBe("TOOL_DISABLED");
  });

  it("leaves settings reads alone and gates settings writes", () => {
    expect(
      decideApiAccess({
        method: "GET",
        path: "/settings",
        query: {},
        enabled: new Set(),
        actionsAllowed: false,
      }).ok
    ).toBe(true);
    expect(
      decideApiAccess({
        method: "POST",
        path: "/settings/",
        query: {},
        enabled,
        actionsAllowed: false,
      }).code
    ).toBe("ACTION_NOT_CONFIRMED");
  });
});
