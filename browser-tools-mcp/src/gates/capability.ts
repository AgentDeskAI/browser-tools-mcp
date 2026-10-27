import net from "node:net";

import { classifyAddress, isLocalName, normalizeHost, originOf } from "../lighthouse/destination.js";
import {
  loadsWithoutScripting,
  RESTRICTED_PAGE_MESSAGE,
  restrictedPage,
} from "../restricted-page.js";

/**
 * Capability gates for script evaluation, real input, and the no-DevTools
 * page actions (tab list, tab read, navigate, soft click, soft type).
 *
 * Everything here defaults off. Process flags are argv only — callers must
 * not copy them from the environment. The human switches are reported by the
 * extension (popup for pages without DevTools, DevTools panel for real input
 * and script evaluation) and reset when the browser session ends.
 *
 * A decision always uses a URL read at decision time. A URL remembered from
 * an earlier page report is not an input to this function.
 */

export const NO_DEVTOOLS_ACTIONS = ["listTabs", "readTab", "navigate", "softClick", "softType"] as const;

export const PANEL_ACTIONS = ["click", "type", "pressKey", "evaluateScript", "debuggerFallback"] as const;

export const INPUT_ACTIONS = [
  "navigate",
  "softClick",
  "softType",
  "click",
  "type",
  "pressKey",
  "debuggerFallback",
] as const;

export const CAPABILITY_ACTIONS = [
  ...NO_DEVTOOLS_ACTIONS,
  "click",
  "type",
  "pressKey",
  "evaluateScript",
  "debuggerFallback",
] as const;

export type CapabilityAction = (typeof CAPABILITY_ACTIONS)[number];

export const GateReason = {
  allowed: "allowed",
  popupOff: "popup switch is off",
  panelOff: "panel switch is off",
  inputOff: "input is not allowed",
  evalOff: "script evaluation is not allowed",
  urlMissing: "tab URL is missing",
  urlNotAllowed: "tab URL is not allowed",
  destinationMissing: "destination URL is missing",
  destinationNotAllowed: "destination is not allowed",
  excluded: "origin is excluded",
  banner: "banner bypass is disabled",
  /** Same wording as restricted-page reports. The page cannot be read or acted on. */
  restricted: RESTRICTED_PAGE_MESSAGE,
  unknown: "unknown action",
  notRechecked: "live tab URL was not re-checked",
  switchUnconfirmed: "popup switch was not confirmed",
  excludeInvalid: "exclude list is invalid",
} as const;

export type GateReasonName = (typeof GateReason)[keyof typeof GateReason];

export interface GatePolicy {
  allowEval: boolean;
  allowInput: boolean;
  /** Explicit http(s) origins, default ports included. Empty unless set. */
  inputOrigins: string[];
  /** User exclude list. Empty unless set. Wins over local and the allowlist. */
  excludeOrigins: string[];
}

export interface GateContext {
  policy: GatePolicy;
  /** Toolbar popup. Default false. Session-scoped in the extension. */
  popupEnabled: boolean;
  /** DevTools panel checkbox. Default false. Session-scoped in the extension. */
  panelEnabled: boolean;
  /** URL from a live tab read immediately before this decision. */
  liveUrl?: string | null;
  /** Navigate target. Held to the same allowlist as the live tab. */
  destinationUrl?: string | null;
  /** Always refused. There is no supported way to hide the debugging banner. */
  hideBanner?: boolean;
}

export interface GateDecision {
  allowed: boolean;
  reason: GateReasonName;
}

export function defaultGatePolicy(): GatePolicy {
  return { allowEval: false, allowInput: false, inputOrigins: [], excludeOrigins: [] };
}

export function isCapabilityAction(value: string): value is CapabilityAction {
  return (CAPABILITY_ACTIONS as readonly string[]).includes(value);
}

export function isNoDevtoolsAction(action: string): boolean {
  return (NO_DEVTOOLS_ACTIONS as readonly string[]).includes(action);
}

/** Hosts that are never an input, read, or navigation target, even if named in the allowlist. */
const NEVER_HOSTS = new Set(["metadata", "metadata.google.internal", "instance-data"]);

export interface ClassifiedGateUrl {
  ok: true;
  origin: string;
  /** Loopback, private, or a local-only name. Public names and public addresses are not local. */
  local: boolean;
}

/**
 * An http(s) URL with no userinfo, or why it cannot be acted on.
 * Blocked and fake-ip addresses are refused here, before any allowlist.
 */
export function classifyGateUrl(
  url: string | null | undefined
): ClassifiedGateUrl | { ok: false; reason: "missing" | "unsupported" | "blocked" } {
  if (url == null || url === "") return { ok: false, reason: "missing" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "unsupported" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported" };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: "unsupported" };

  const host = normalizeHost(parsed.hostname);
  if (!host || NEVER_HOSTS.has(host)) return { ok: false, reason: "blocked" };

  const origin = originOf(parsed);
  if (!origin) return { ok: false, reason: "unsupported" };

  if (net.isIP(host)) {
    const klass = classifyAddress(host);
    if (klass === "blocked" || klass === "fake-ip") return { ok: false, reason: "blocked" };
    return { ok: true, origin, local: klass === "loopback" || klass === "private" };
  }

  return { ok: true, origin, local: isLocalName(host) };
}

/** scheme://host[:port] with an explicit http(s) scheme. Anything else is rejected, not assumed. */
export function normalizeGateOrigin(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.includes("*")) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return originOf(trimmed);
}

export function normalizeOriginList(entries: readonly string[] | undefined): {
  origins: string[];
  rejected: string[];
} {
  const origins: string[] = [];
  const rejected: string[] = [];
  for (const raw of entries ?? []) {
    const origin = normalizeGateOrigin(raw);
    if (origin) origins.push(origin);
    else if (raw.trim()) rejected.push(raw);
  }
  return { origins: [...new Set(origins)], rejected };
}

function matchesList(origin: string, list: readonly string[]): boolean {
  return normalizeOriginList(list).origins.includes(origin);
}

export interface UrlPermission {
  permitted: boolean;
  reason: GateReasonName;
}

/**
 * Input, navigation, script evaluation, and soft input.
 * Local origins are permitted. Anything else must be listed. Excluded and
 * blocked origins are not permitted.
 */
export function inputUrlPermitted(
  url: string | null | undefined,
  policy: GatePolicy,
  kind: "tab" | "destination" = "tab"
): UrlPermission {
  const missing = kind === "destination" ? GateReason.destinationMissing : GateReason.urlMissing;
  const notAllowed = kind === "destination" ? GateReason.destinationNotAllowed : GateReason.urlNotAllowed;
  const classified = classifyGateUrl(url);
  if (!classified.ok) {
    return { permitted: false, reason: classified.reason === "missing" ? missing : notAllowed };
  }
  if (matchesList(classified.origin, policy.excludeOrigins)) {
    return { permitted: false, reason: GateReason.excluded };
  }
  if (classified.local || matchesList(classified.origin, policy.inputOrigins)) {
    return { permitted: true, reason: GateReason.allowed };
  }
  return { permitted: false, reason: notAllowed };
}

/**
 * Reading a tab is not limited to local origins (the user asked to see the
 * tabs they actually have open). Excluded origins, non-http(s) URLs, and
 * blocked addresses are still refused.
 */
export function readUrlPermitted(url: string | null | undefined, policy: GatePolicy): UrlPermission {
  const classified = classifyGateUrl(url);
  if (!classified.ok) {
    return {
      permitted: false,
      reason: classified.reason === "missing" ? GateReason.urlMissing : GateReason.urlNotAllowed,
    };
  }
  if (matchesList(classified.origin, policy.excludeOrigins)) {
    return { permitted: false, reason: GateReason.excluded };
  }
  return { permitted: true, reason: GateReason.allowed };
}

/** Whether a tab URL may appear in a listing. Excluded origins are left out. */
export function tabListed(url: string | null | undefined, policy: GatePolicy): boolean {
  if (url == null || url === "") return true;
  const classified = classifyGateUrl(url);
  if (!classified.ok) return classified.reason !== "blocked";
  return !matchesList(classified.origin, policy.excludeOrigins);
}

function deny(reason: GateReasonName): GateDecision {
  return { allowed: false, reason };
}

export function decideCapability(action: string, context: GateContext): GateDecision {
  if (context.hideBanner === true) return deny(GateReason.banner);
  if (!isCapabilityAction(action)) return deny(GateReason.unknown);

  const needsPopup = isNoDevtoolsAction(action);
  const needsPanel = (PANEL_ACTIONS as readonly string[]).includes(action);
  const needsInput = (INPUT_ACTIONS as readonly string[]).includes(action);
  const needsEval = action === "evaluateScript";

  if (needsPopup && context.popupEnabled !== true) return deny(GateReason.popupOff);
  if (needsPanel && context.panelEnabled !== true) return deny(GateReason.panelOff);
  if (needsInput && context.policy.allowInput !== true) return deny(GateReason.inputOff);
  if (needsEval && context.policy.allowEval !== true) return deny(GateReason.evalOff);

  if (action === "listTabs") return { allowed: true, reason: GateReason.allowed };

  if (action === "readTab") {
    if (restrictedPage(context.liveUrl)) return deny(GateReason.restricted);
    const read = readUrlPermitted(context.liveUrl, context.policy);
    return read.permitted ? { allowed: true, reason: GateReason.allowed } : deny(read.reason);
  }

  if (action === "navigate") {
    // A chrome:// (or similar) tab has no scriptable origin. Leaving it is
    // allowed; the destination is still checked. http(s) PDFs may load and are
    // reported afterwards. Every other restricted destination is refused here.
    if (!restrictedPage(context.liveUrl)) {
      const live = inputUrlPermitted(context.liveUrl, context.policy, "tab");
      if (!live.permitted) return deny(live.reason);
    }
    if (restrictedPage(context.destinationUrl) && !loadsWithoutScripting(context.destinationUrl)) {
      return deny(GateReason.restricted);
    }
    const destination = inputUrlPermitted(context.destinationUrl, context.policy, "destination");
    if (!destination.permitted) return deny(destination.reason);
    return { allowed: true, reason: GateReason.allowed };
  }

  if (restrictedPage(context.liveUrl)) return deny(GateReason.restricted);

  const live = inputUrlPermitted(context.liveUrl, context.policy, "tab");
  if (!live.permitted) return deny(live.reason);

  return { allowed: true, reason: GateReason.allowed };
}
