import { RESTRICTED_PAGE_MESSAGE } from "../restricted-page.js";

/**
 * Tab-awareness contracts (AGE-584).
 *
 * Two id spaces, kept apart in every description:
 *
 * - A DevTools-connected tab id comes from listBrowserTabs. It is
 *   chrome.devtools.inspectedWindow.tabId for a tab whose DevTools page is
 *   connected to the connector. Pass it as `tabId` to the existing tools.
 * - A chrome.tabs id comes from listTabs. It is chrome.tabs.Tab.id for a tab
 *   the browser returned. Pass it as `chromeTabId` to listTabs, readTab,
 *   snapshotTab, navigateTab, softClick, softType, and actOnRef.
 *
 * Chrome often uses the same integer for both when DevTools is open on that
 * tab. The tools still do not accept each other's ids: a DevTools-connected
 * id only addresses a connected DevTools page, and a chrome.tabs id is only
 * valid when listTabs returned it.
 */

/** What listTabs is willing to claim. AGE-618 left Arc unmeasured. */
export const TAB_COVERAGE =
  "Tabs the browser exposes through chrome.tabs in the windows it returns. " +
  "Other Arc Spaces, Little Arc, pinned favorites, split-view partners, and slept tabs may be missing. " +
  "Incognito is skipped. This is not every open tab.";

export const DEVTOOLS_TAB_ID =
  "DevTools-connected tab id from listBrowserTabs (the inspected tab whose DevTools page is connected). " +
  "Not a chromeTabId from listTabs. Do not pass a chrome.tabs id here.";

export const CHROME_TAB_ID =
  "chrome.tabs id from listTabs (chrome.tabs.Tab.id). Not a DevTools-connected tabId from listBrowserTabs. " +
  "Pass only an id listTabs returned.";

export const LIST_BROWSER_TABS_DESCRIPTION =
  "Every browser tab that currently has DevTools open, with the DevTools-connected tabId you can pass to the telemetry tools. " +
  "These ids are not chromeTabId values from listTabs. This list is only tabs with DevTools open, not every open tab. " +
  "Call this when a result reported otherTabs above 0, or when the user mentions a page other than the one you have been reading. " +
  "The tab marked isCurrent is the one the DevTools tools use when you do not pass tabId. " +
  "A tab on chrome://, DevTools, view-source, the Chrome Web Store, an extension page, or the PDF viewer " +
  `is metadata only (access "metadata-only", "${RESTRICTED_PAGE_MESSAGE}") and cannot be scripted.`;

export const DEVTOOLS_TAB_INPUT =
  "DevTools-connected tab id from listBrowserTabs. Not a chromeTabId from listTabs. " +
  "Omit to use the current tab — the one DevTools was most recently opened on, which is right in almost every session. " +
  "Only pass this when a result reported otherTabs above 0 and you need a specific DevTools-connected tab.";

export const NAVIGATE_BROWSER_DESCRIPTION =
  "Loads a URL in a DevTools-connected tab without focusing it or attaching the debugger. " +
  "tabId is a DevTools-connected id from listBrowserTabs, not a chromeTabId from listTabs. " +
  "Requires the extension service worker, the popup switch, and --allow-input on browser-tools-mcp " +
  "(browser-tools CLI: --allow-actions). Does not call chrome.tabs.update({active:true}) or chrome.windows.update({focused:true}). " +
  "chrome://, DevTools, view-source, the Chrome Web Store, and extension pages are refused. " +
  "An http(s) PDF may load, then the tool fails because the viewer cannot be scripted. " +
  `The error text is JSON with access "metadata-only" and message "${RESTRICTED_PAGE_MESSAGE}".`;

export const LIST_TABS_DESCRIPTION =
  TAB_COVERAGE +
  " Each tab includes title, URL, site, window, last viewed, and whether it is asleep (discarded) or frozen. " +
  "chromeTabId is a chrome.tabs id, not a DevTools-connected tabId from listBrowserTabs. " +
  "Uses chrome.tabs and chrome.windows only. Does not attach the debugger and does not change focus. " +
  "Needs the extension popup switch. The exclude list, empty by default, drops matching origins.";

export const READ_TAB_DESCRIPTION =
  "Reads headings, a short excerpt, and a compact snapshot of a tab from listTabs, without DevTools and without the debugger. " +
  "chromeTabId is a chrome.tabs id from listTabs, not a DevTools-connected tabId from listBrowserTabs. " +
  "Private details are stripped in the browser before the result leaves the page. " +
  "An asleep (discarded) tab is reported as asleep and is not reloaded. A frozen tab is skipped. " +
  "chrome:// pages, the Chrome Web Store, and the PDF viewer cannot be read. " +
  "Needs the popup switch and host access for that site. Does not change focus.";

export const NAVIGATE_TAB_DESCRIPTION =
  "Loads a URL in the background with chrome.tabs, without DevTools and without the debugger. " +
  "Pass chromeTabId from listTabs to update that tab, or omit it to open a new background tab. " +
  "chromeTabId is not a DevTools-connected tabId from listBrowserTabs. " +
  "Limited to the visible window until Arc Spaces are measured: a tab in another window is refused, and nothing switches window or Space. " +
  "Never activates the tab or focuses the window. " +
  "Gated like input: popup switch, --allow-input (browser-tools CLI: --allow-actions), and the same origin rules. " +
  "Reports the final URL, whether an asleep tab was woken (wasDiscarded), and any tab or popup the page opened.";

export const SOFT_CLICK_DESCRIPTION =
  "Clicks an element in a tab from listTabs by dispatching untrusted pointer events. Does not attach the debugger and does not change focus. " +
  "chromeTabId is a chrome.tabs id from listTabs, not a DevTools-connected tabId from listBrowserTabs. " +
  "A submit control uses form.requestSubmit() rather than form.submit(). " +
  "The result is outcome \"worked\" or \"needs a real gesture\" with a reason (file picker, clipboard, popup, fullscreen, " +
  "the site checks isTrusted, anti-bot check, Google Docs or canvas app, or UI that needs the page drawn). " +
  "A failed action is never reported as worked. " +
  "Gated like input: popup switch, --allow-input (browser-tools CLI: --allow-actions), and the same origin rules.";

export const SOFT_TYPE_DESCRIPTION =
  "Types into an element in a tab from listTabs without the debugger and without changing focus. " +
  "chromeTabId is a chrome.tabs id from listTabs, not a DevTools-connected tabId from listBrowserTabs. " +
  "Ordinary inputs use the native value setter, then input and change events, so React and Vue fields update. " +
  "Rich editors (contenteditable, ProseMirror, Lexical) are focused in the page and receive execCommand('insertText'). " +
  "Pass submit true to submit the surrounding form with requestSubmit(). " +
  "The result is outcome \"worked\" or \"needs a real gesture\" with a reason. A failed action is never reported as worked. " +
  "Gated like input: popup switch, --allow-input (browser-tools CLI: --allow-actions), and the same origin rules.";

export const SNAPSHOT_TAB_DESCRIPTION =
  "Builds a semantic page map of a tab from listTabs. Each entry has a role, an accessible name, text, state, visibility, and a stable ref. " +
  "chromeTabId is a chrome.tabs id from listTabs, not a DevTools-connected tabId from listBrowserTabs. " +
  "Does not attach the debugger and does not change focus. At most 80 elements. " +
  "The same element keeps its ref until the document is replaced. " +
  "Private details are stripped in the browser before the result leaves the page. " +
  "An asleep (discarded) tab is reported as asleep and is not reloaded. A frozen tab is skipped. " +
  "chrome:// pages, the Chrome Web Store, and the PDF viewer cannot be mapped. " +
  "Needs the popup switch and host access for that site.";

export const ACT_ON_REF_DESCRIPTION =
  "Clicks or types on a ref from snapshotTab, using the same untrusted click and type path as softClick and softType. " +
  "Does not attach the debugger and does not change focus. " +
  "chromeTabId is a chrome.tabs id from listTabs, not a DevTools-connected tabId from listBrowserTabs. " +
  "op is click or type. A type uses the native value setter or execCommand('insertText'), and submit true uses form.requestSubmit(). " +
  "The result is outcome \"worked\" or \"needs a real gesture\" with a reason, plus a short delta: whether the URL changed, " +
  "console errors that appeared after the action, and network requests that failed after the action. " +
  "A failed action is never reported as worked. " +
  "Gated like input: popup switch, --allow-input (browser-tools CLI: --allow-actions), and the same origin rules.";

export const SOFT_OUTCOMES = ["worked", "needs a real gesture"] as const;
export type SoftOutcome = (typeof SOFT_OUTCOMES)[number];

export const GESTURE_REASONS = [
  "file picker",
  "clipboard",
  "popup",
  "fullscreen",
  "the site checks isTrusted",
  "anti-bot check",
  "Google Docs or canvas app",
  "UI that needs the page drawn",
] as const;
export type GestureReason = (typeof GESTURE_REASONS)[number];

export interface ChromeTabView {
  chromeTabId: number;
  windowId: number;
  title: string;
  url: string;
  site: string;
  active: boolean;
  pinned: boolean;
  /** chrome.tabs discarded. Asleep. Not reloaded by a read. */
  discarded: boolean;
  frozen: boolean;
  /** chrome.tabs lastAccessed, milliseconds, or null when the browser omitted it. */
  lastAccessed: number | null;
  audible: boolean;
  status: string;
  index: number;
}

export interface ChromeWindowView {
  windowId: number;
  focused: boolean;
  type: string;
  incognito: false;
  tabs: ChromeTabView[];
}

export interface ChromeTabListing {
  coverage: string;
  visibleWindowId: number | null;
  windows: ChromeWindowView[];
}

export interface ChromeTabHeading {
  level: number;
  text: string;
}

export interface ChromeTabSnapshotNode {
  depth: number;
  role: string;
  name: string;
}

export interface ChromeTabRead {
  chromeTabId: number;
  url: string;
  title: string;
  site: string;
  asleep: boolean;
  frozen: boolean;
  /** Set when the tab was not read. "frozen" or a short reason. */
  skipped: string | null;
  headings: ChromeTabHeading[];
  excerpt: string;
  snapshot: ChromeTabSnapshotNode[];
  hostAccess: boolean;
}

export interface OpenedTab {
  chromeTabId: number;
  url: string;
  windowId: number;
  active: boolean;
}

export interface SafetyCounts {
  debuggerCalls: number;
  focusChanges: number;
}

export interface ChromeNavigateResult {
  chromeTabId: number;
  requestedUrl: string;
  finalUrl: string;
  wasDiscarded: boolean;
  created: boolean;
  visibleWindowId: number;
  openedTabs: OpenedTab[];
  safety: SafetyCounts;
}

export interface SoftInputResult {
  chromeTabId: number;
  outcome: SoftOutcome;
  reason: GestureReason | null;
  detail: string;
  /** Synthetic events are never trusted. Always false. */
  trusted: false;
}

export interface SemanticState {
  disabled?: boolean;
  checked?: boolean | "mixed";
  expanded?: boolean;
  pressed?: boolean | "mixed";
  selected?: boolean;
  required?: boolean;
  invalid?: boolean;
  readonly?: boolean;
}

export interface SemanticNode {
  ref: string;
  role: string;
  name: string;
  text: string;
  state: SemanticState;
  visible: boolean;
  depth: number;
}

export interface SemanticSnapshot {
  chromeTabId: number;
  url: string;
  title: string;
  site: string;
  asleep: boolean;
  frozen: boolean;
  skipped: string | null;
  hostAccess: boolean;
  truncated: boolean;
  nodes: SemanticNode[];
}

export interface FailedRequestDelta {
  url: string;
  status: number | null;
}

export interface PageChangeDelta {
  urlChanged: boolean;
  previousUrl: string;
  url: string;
  consoleErrors: string[];
  failedRequests: FailedRequestDelta[];
}

export interface ActOnRefResult {
  chromeTabId: number;
  ref: string;
  outcome: SoftOutcome;
  reason: GestureReason | null;
  detail: string;
  trusted: false;
  delta: PageChangeDelta;
}

export const TAB_TOOL_NAMES = [
  "listTabs",
  "readTab",
  "snapshotTab",
  "navigateTab",
  "softClick",
  "softType",
  "actOnRef",
] as const;
