import { tabListed, type GatePolicy } from "../gates/capability.js";
import { originOf } from "../lighthouse/destination.js";
import { redactSecretsInString } from "../util/redact.js";
import {
  GESTURE_REASONS,
  TAB_COVERAGE,
  type ChromeNavigateResult,
  type ChromeTabHeading,
  type ChromeTabListing,
  type ActOnRefResult,
  type ChromeTabRead,
  type ChromeTabSnapshotNode,
  type ChromeTabView,
  type FailedRequestDelta,
  type PageChangeDelta,
  type SemanticNode,
  type SemanticSnapshot,
  type SemanticState,
  type ChromeWindowView,
  type GestureReason,
  type OpenedTab,
  type SafetyCounts,
  type SoftInputResult,
  type SoftOutcome,
} from "./contract.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function siteOf(url: string): string {
  return originOf(url) ?? "";
}

/** Drops incognito and excluded origins. Secrets in titles and URLs are redacted. */
export function normalizeChromeTabListing(payload: unknown, policy: GatePolicy): ChromeTabListing {
  const root = asRecord(payload) ?? {};
  const visibleWindowId = finiteNumber(root["visibleWindowId"]);
  const rawWindows = Array.isArray(root["windows"]) ? root["windows"] : [];
  const windows: ChromeWindowView[] = [];

  for (const rawWindow of rawWindows) {
    const window = asRecord(rawWindow);
    if (!window || window["incognito"] === true) continue;
    const windowId = finiteNumber(window["windowId"]);
    if (windowId === null) continue;
    const rawTabs = Array.isArray(window["tabs"]) ? window["tabs"] : [];
    const tabs: ChromeTabView[] = [];
    for (const rawTab of rawTabs) {
      const tab = asRecord(rawTab);
      if (!tab || tab["incognito"] === true) continue;
      const chromeTabId = finiteNumber(tab["chromeTabId"]);
      if (chromeTabId === null) continue;
      const url = redactSecretsInString(typeof tab["url"] === "string" ? tab["url"] : "");
      if (!tabListed(url, policy)) continue;
      tabs.push({
        chromeTabId,
        windowId: finiteNumber(tab["windowId"]) ?? windowId,
        title: redactSecretsInString(typeof tab["title"] === "string" ? tab["title"] : "").slice(0, 300),
        url,
        site: siteOf(url),
        active: tab["active"] === true,
        pinned: tab["pinned"] === true,
        discarded: tab["discarded"] === true,
        frozen: tab["frozen"] === true,
        lastAccessed: finiteNumber(tab["lastAccessed"]),
        audible: tab["audible"] === true,
        status: typeof tab["status"] === "string" ? tab["status"] : "",
        index: finiteNumber(tab["index"]) ?? 0,
      });
    }
    windows.push({
      windowId,
      focused: window["focused"] === true,
      type: typeof window["type"] === "string" ? window["type"] : "normal",
      incognito: false,
      tabs,
    });
  }

  return { coverage: TAB_COVERAGE, visibleWindowId, windows };
}

export function readSafety(payload: Record<string, unknown>): SafetyCounts {
  const safety = asRecord(payload["safety"]);
  return {
    debuggerCalls: finiteNumber(safety?.["debuggerCalls"]) ?? 0,
    focusChanges: finiteNumber(safety?.["focusChanges"]) ?? 0,
  };
}

export function assertTabActionSafe(payload: Record<string, unknown>): SafetyCounts {
  const safety = readSafety(payload);
  if (safety.debuggerCalls > 0 || safety.focusChanges > 0) {
    throw new Error("The tab action tried to attach the debugger or change focus, so it was refused.");
  }
  return safety;
}

function text(value: unknown, max: number): string {
  return redactSecretsInString(typeof value === "string" ? value : "").slice(0, max);
}

export function parseChromeTabRead(chromeTabId: number, value: unknown): ChromeTabRead {
  const read = asRecord(value) ?? {};
  const url = text(read["url"], 2000);
  const headings: ChromeTabHeading[] = [];
  if (Array.isArray(read["headings"])) {
    for (const item of read["headings"].slice(0, 30)) {
      const heading = asRecord(item);
      if (!heading) continue;
      const level = finiteNumber(heading["level"]);
      headings.push({
        level: level !== null && level >= 1 && level <= 6 ? level : 1,
        text: text(heading["text"], 200),
      });
    }
  }
  const snapshot: ChromeTabSnapshotNode[] = [];
  if (Array.isArray(read["snapshot"])) {
    for (const item of read["snapshot"].slice(0, 60)) {
      const node = asRecord(item);
      if (!node) continue;
      snapshot.push({
        depth: finiteNumber(node["depth"]) ?? 0,
        role: text(node["role"], 40),
        name: text(node["name"], 80),
      });
    }
  }
  const skipped = typeof read["skipped"] === "string" && read["skipped"] ? read["skipped"].slice(0, 120) : null;
  return {
    chromeTabId,
    url,
    title: text(read["title"], 300),
    site: siteOf(url),
    asleep: read["asleep"] === true,
    frozen: read["frozen"] === true,
    skipped,
    headings,
    excerpt: text(read["excerpt"], 800),
    snapshot,
    hostAccess: read["hostAccess"] === true,
  };
}

function parseOpenedTabs(value: unknown): OpenedTab[] {
  if (!Array.isArray(value)) return [];
  const opened: OpenedTab[] = [];
  for (const item of value.slice(0, 20)) {
    const tab = asRecord(item);
    if (!tab) continue;
    const chromeTabId = finiteNumber(tab["chromeTabId"]);
    const windowId = finiteNumber(tab["windowId"]);
    if (chromeTabId === null || windowId === null) continue;
    opened.push({
      chromeTabId,
      windowId,
      url: text(tab["url"], 2000),
      active: tab["active"] === true,
    });
  }
  return opened;
}

export function parseChromeNavigate(requestedUrl: string, payload: Record<string, unknown>): ChromeNavigateResult {
  const safety = assertTabActionSafe(payload);
  const chromeTabId = finiteNumber(payload["chromeTabId"]);
  const visibleWindowId = finiteNumber(payload["visibleWindowId"]);
  if (chromeTabId === null || visibleWindowId === null) {
    throw new Error("The extension returned an incomplete navigation result.");
  }
  return {
    chromeTabId,
    requestedUrl,
    finalUrl: text(payload["finalUrl"], 2000) || requestedUrl,
    wasDiscarded: payload["wasDiscarded"] === true,
    created: payload["created"] === true,
    visibleWindowId,
    openedTabs: parseOpenedTabs(payload["openedTabs"]),
    safety,
  };
}

const REF_PATTERN = /^e[1-9][0-9]{0,4}$/;

function parseState(value: unknown): SemanticState {
  const raw = asRecord(value) ?? {};
  const state: SemanticState = {};
  if (raw["disabled"] === true) state.disabled = true;
  const checked = raw["checked"];
  if (checked === true || checked === false || checked === "mixed") state.checked = checked;
  if (raw["expanded"] === true || raw["expanded"] === false) state.expanded = raw["expanded"];
  const pressed = raw["pressed"];
  if (pressed === true || pressed === false || pressed === "mixed") state.pressed = pressed;
  if (raw["selected"] === true || raw["selected"] === false) state.selected = raw["selected"];
  if (raw["required"] === true) state.required = true;
  if (raw["invalid"] === true) state.invalid = true;
  if (raw["readonly"] === true) state.readonly = true;
  return state;
}

export function parseSemanticSnapshot(chromeTabId: number, value: unknown): SemanticSnapshot {
  const read = asRecord(value) ?? {};
  const url = text(read["url"], 2000);
  const nodes: SemanticNode[] = [];
  if (Array.isArray(read["nodes"])) {
    for (const item of read["nodes"].slice(0, 80)) {
      const node = asRecord(item);
      if (!node) continue;
      const ref = typeof node["ref"] === "string" ? node["ref"] : "";
      if (!REF_PATTERN.test(ref)) continue;
      const depth = finiteNumber(node["depth"]) ?? 0;
      nodes.push({
        ref,
        role: text(node["role"], 40),
        name: text(node["name"], 120),
        text: text(node["text"], 160),
        state: parseState(node["state"]),
        visible: node["visible"] === true,
        depth: depth >= 0 && depth <= 40 ? depth : 0,
      });
    }
  }
  const skipped = typeof read["skipped"] === "string" && read["skipped"] ? read["skipped"].slice(0, 120) : null;
  return {
    chromeTabId,
    url,
    title: text(read["title"], 300),
    site: siteOf(url),
    asleep: read["asleep"] === true,
    frozen: read["frozen"] === true,
    skipped,
    hostAccess: read["hostAccess"] === true,
    truncated: read["truncated"] === true,
    nodes,
  };
}

function parseDelta(value: unknown): PageChangeDelta {
  const delta = asRecord(value);
  if (!delta) throw new Error("The action did not report what changed.");
  const previousUrl = text(delta["previousUrl"], 2000);
  const url = text(delta["url"], 2000);
  const consoleErrors: string[] = [];
  if (Array.isArray(delta["consoleErrors"])) {
    for (const item of delta["consoleErrors"].slice(0, 8)) {
      const line = text(item, 240);
      if (line) consoleErrors.push(line);
    }
  }
  const failedRequests: FailedRequestDelta[] = [];
  if (Array.isArray(delta["failedRequests"])) {
    for (const item of delta["failedRequests"].slice(0, 8)) {
      const request = asRecord(item);
      if (!request) continue;
      const requestUrl = text(request["url"], 300);
      const status = finiteNumber(request["status"]);
      failedRequests.push({
        url: requestUrl,
        status: status !== null && status >= 100 && status <= 599 ? Math.trunc(status) : null,
      });
    }
  }
  return {
    urlChanged: url !== previousUrl,
    previousUrl,
    url,
    consoleErrors,
    failedRequests,
  };
}

export function parseActOnRef(chromeTabId: number, ref: string, payload: Record<string, unknown>): ActOnRefResult {
  assertTabActionSafe(payload);
  if (!REF_PATTERN.test(ref)) throw new Error("ref must be a ref from snapshotTab");
  const outcome = payload["outcome"];
  if (outcome !== "worked" && outcome !== "needs a real gesture") {
    throw new Error("The action did not report worked or needs a real gesture.");
  }
  const reasonRaw = payload["reason"];
  const reason = GESTURE_REASONS.find((entry) => entry === reasonRaw) ?? null;
  if (outcome === "needs a real gesture" && !reason) {
    throw new Error("The action refused without a reason.");
  }
  return {
    chromeTabId,
    ref,
    outcome,
    reason: outcome === "worked" ? null : reason,
    detail: text(payload["detail"], 300),
    trusted: false,
    delta: parseDelta(payload["delta"]),
  };
}

export function parseSoftInput(chromeTabId: number, payload: Record<string, unknown>): SoftInputResult {
  assertTabActionSafe(payload);
  const outcome = payload["outcome"];
  if (outcome !== "worked" && outcome !== "needs a real gesture") {
    throw new Error("Soft input did not report worked or needs a real gesture.");
  }
  const reasonRaw = payload["reason"];
  const reason = GESTURE_REASONS.find((entry) => entry === reasonRaw) ?? null;
  if (outcome === "needs a real gesture" && !reason) {
    throw new Error("Soft input refused without a reason.");
  }
  const parsed: SoftInputResult = {
    chromeTabId,
    outcome: outcome as SoftOutcome,
    reason: outcome === "worked" ? null : (reason as GestureReason),
    detail: text(payload["detail"], 300),
    trusted: false,
  };
  return parsed;
}
