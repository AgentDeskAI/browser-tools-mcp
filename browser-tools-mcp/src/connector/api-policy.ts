import { AUDIT_CATEGORIES, isAuditCategory, type AuditCategory } from "../lighthouse/types.js";

/**
 * Which MCP tools the local HTTP API is willing to serve.
 *
 * `--only` / `--exclude` already hide tools from the MCP client. The same
 * selection applies here, so a client that can reach the connector directly
 * cannot call a tool the operator turned off.
 */
export function resolveEnabledTools(
  all: readonly string[],
  enabled?: readonly string[],
  disabled?: readonly string[]
): { enabled: Set<string>; unknown: string[] } {
  const known = new Set(all);
  const unknown = (enabled ?? []).filter((name) => !known.has(name));
  const base = enabled ? enabled.filter((name) => known.has(name)) : [...all];
  const blocked = new Set(disabled ?? []);
  return {
    enabled: new Set(base.filter((name) => !blocked.has(name))),
    unknown,
  };
}

const AUDIT_TOOL: Record<AuditCategory, string> = {
  accessibility: "runAccessibilityAudit",
  performance: "runPerformanceAudit",
  seo: "runSEOAudit",
  "best-practices": "runBestPracticesAudit",
};

/**
 * Every tool the local API can serve. Kept in step with the MCP tool list by
 * a unit test, so a new tool cannot skip the filter by accident.
 */
export const API_TOOL_NAMES: readonly string[] = [
  "listTabs",
  "readTab",
  "navigateTab",
  "softClick",
  "softType",
  "listBrowserTabs",
  "getConsoleLogs",
  "getConsoleErrors",
  "getNetworkLogs",
  "getNetworkErrors",
  "getSelectedElement",
  "getPageInfo",
  "getConnectionStatus",
  "takeScreenshot",
  "refreshBrowser",
  "navigateBrowser",
  "getBrowserStorage",
  "wipeLogs",
  ...AUDIT_CATEGORIES.map((category) => AUDIT_TOOL[category]),
];

export type ApiDenial = "TOOL_DISABLED" | "ACTION_NOT_CONFIRMED";

export interface ApiDecision {
  ok: boolean;
  code?: ApiDenial;
  error?: string;
}

const TOOL_DISABLED = "This call is not enabled (--only / --exclude).";
const ACTION_NOT_CONFIRMED =
  "State-changing calls need --allow-input on the connector (browser-tools CLI: --allow-actions), " +
  "or confirmation in the BrowserTools panel.";

function truthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes"].includes(value.toLowerCase());
}

function anyEnabled(enabled: ReadonlySet<string>, tools: readonly string[]): boolean {
  return tools.some((tool) => enabled.has(tool));
}

/** Longest category first, so `best-practices` wins over a shorter prefix. */
function categoryFromArtifactName(name: string): AuditCategory | null {
  const categories = [...AUDIT_CATEGORIES].sort((a, b) => b.length - a.length);
  for (const category of categories) {
    if (name === category || name.startsWith(`${category}-`)) return category;
  }
  return null;
}

/**
 * Tools a request is allowed to exercise. `null` means the route is not a
 * tool (settings, for example) and the tool filter does not apply.
 */
function toolsForRequest(method: string, path: string, query: Record<string, unknown>): string[] | null {
  if (method === "GET" && path === "/console") {
    return [truthyFlag(query["errorsOnly"]) ? "getConsoleErrors" : "getConsoleLogs"];
  }
  if (method === "GET" && path === "/network") {
    return [truthyFlag(query["errorsOnly"]) ? "getNetworkErrors" : "getNetworkLogs"];
  }
  if (method === "GET" && path === "/selected-element") return ["getSelectedElement"];
  if (method === "GET" && path === "/page") return ["getPageInfo"];
  if (method === "GET" && path === "/status") return ["getConnectionStatus"];
  if (method === "GET" && path === "/tabs") return ["listBrowserTabs"];
  if (method === "GET" && path === "/chrome-tabs") return ["listTabs"];
  if (method === "POST" && path === "/chrome-tabs/read") return ["readTab"];
  if (method === "POST" && path === "/chrome-tabs/navigate") return ["navigateTab"];
  if (method === "POST" && path === "/chrome-tabs/soft-click") return ["softClick"];
  if (method === "POST" && path === "/chrome-tabs/soft-type") return ["softType"];
  if (method === "POST" && path === "/screenshot") return ["takeScreenshot"];
  if (method === "POST" && path === "/refresh") return ["refreshBrowser"];
  if (method === "POST" && path === "/navigate") return ["navigateBrowser"];
  if (method === "POST" && path === "/storage") return ["getBrowserStorage"];
  if (method === "POST" && path === "/wipe") return ["wipeLogs"];
  if (method === "GET" && path === "/export/console") return ["getConsoleLogs", "getConsoleErrors"];
  if (method === "GET" && path === "/export/network") return ["getNetworkLogs", "getNetworkErrors"];

  const artifact = /^\/artifact\/([^/]+)\/([^/]+)$/.exec(path);
  if (method === "GET" && artifact) {
    const kind = artifact[1] ?? "";
    const name = artifact[2] ?? "";
    if (kind === "screenshot") return ["takeScreenshot"];
    if (kind === "audit") {
      const category = categoryFromArtifactName(name);
      return category ? [AUDIT_TOOL[category]] : [...Object.values(AUDIT_TOOL)];
    }
    return null;
  }

  const audit = /^\/audit\/([^/]+)$/.exec(path);
  if (method === "POST" && audit) {
    const category = audit[1] ?? "";
    if (!isAuditCategory(category)) return null;
    return [AUDIT_TOOL[category]];
  }

  return null;
}

/** Reloads, captures, wipes, settings writes and tab selection change state. */
export function isStateChangingRequest(method: string, path: string): boolean {
  return (
    method === "POST" &&
    (path === "/wipe" ||
      path === "/screenshot" ||
      path === "/refresh" ||
      path === "/navigate" ||
      path === "/chrome-tabs/navigate" ||
      path === "/chrome-tabs/soft-click" ||
      path === "/chrome-tabs/soft-type" ||
      path === "/settings" ||
      path === "/tabs/select")
  );
}

/**
 * Decides whether one local API request may proceed.
 *
 * Tool filtering runs first, then the confirmation gate, so a disabled tool
 * stays disabled even when actions have been confirmed.
 */
export function decideApiAccess(input: {
  method: string;
  path: string;
  query: Record<string, unknown>;
  enabled: ReadonlySet<string>;
  actionsAllowed: boolean;
}): ApiDecision {
  const method = input.method.toUpperCase();
  const path =
    input.path.length > 1 && input.path.endsWith("/") ? input.path.slice(0, -1) : input.path;

  const tools = toolsForRequest(method, path, input.query);
  if (tools && !anyEnabled(input.enabled, tools)) {
    return { ok: false, code: "TOOL_DISABLED", error: TOOL_DISABLED };
  }
  if (isStateChangingRequest(method, path) && !input.actionsAllowed) {
    return { ok: false, code: "ACTION_NOT_CONFIRMED", error: ACTION_NOT_CONFIRMED };
  }
  return { ok: true };
}
