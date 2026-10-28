import type {
  Artifact,
  Connector,
  ExportResult,
  TabScopedResult,
  TabView,
} from "../connector/connector.js";
import type {
  ConsoleEntry,
  ConsoleQuery,
  NetworkEntry,
  NetworkQuery,
  TabId,
} from "../connector/store.js";
import type { AuditCategory, AuditReport } from "../lighthouse/types.js";
import {
  restrictedPageErrorFromPayload,
  restrictedPageFields,
  type RestrictedPageKind,
} from "../restricted-page.js";
import type {
  ChromeNavigateResult,
  ChromeTabListing,
  ChromeTabRead,
  SoftInputResult,
} from "../tabs/contract.js";
import type { TimelineListing, TimelineQuery, TimelineResult } from "../timeline/store.js";

export interface PageInfo {
  url: string;
  tabId: number | string | null;
  extensionConnected: boolean;
  connectedTabs: number;
  /** Present when the current page cannot be scripted. */
  access?: "metadata-only";
  message?: string;
  scriptable?: false;
  kind?: RestrictedPageKind;
  detail?: string;
}

export interface TabListing {
  tabs: TabView[];
  currentTabId: TabId | null;
  connectedTabs: number;
}

export type ScopedConsoleQuery = ConsoleQuery & { allTabs?: boolean };
export type ScopedNetworkQuery = NetworkQuery & { allTabs?: boolean };

export interface ConnectorStatus {
  version: string;
  extensionConnected: boolean;
  connections: number;
  tabs: number;
  currentTabId: TabId | null;
  screenshotDir: string;
  counts: { console: number; network: number };
}

export interface NavigateResult {
  tabId: TabId;
  requestedUrl: string;
  finalUrl: string;
  wasDiscarded: boolean;
}

export interface ScreenshotResult {
  path: string;
  tabId?: TabId | null;
  url?: string;
  /** Data URL, carrying whichever format the browser settled on. */
  data: string;
  name: string;
  mimeType: string;
  bytes: number;
  /** False when the image is too large to hand to the model. */
  withinBudget: boolean;
}

/**
 * The operations the MCP tools need. Implemented both in-process (the normal
 * single-process setup) and over HTTP (when attaching to a connector that is
 * already running for another client).
 */
export interface ConnectorClient {
  console(query: ScopedConsoleQuery): Promise<TabScopedResult<ConsoleEntry>>;
  network(query: ScopedNetworkQuery): Promise<TabScopedResult<NetworkEntry>>;
  selectedElement(options?: { tabId?: TabId }): Promise<unknown>;
  page(): Promise<PageInfo>;
  status(): Promise<ConnectorStatus>;
  tabs(): Promise<TabListing>;
  wipe(options?: { tabId?: TabId }): Promise<void>;
  screenshot(options: { name?: string; tabId?: TabId }): Promise<ScreenshotResult>;
  refresh(options?: { tabId?: TabId }): Promise<void>;
  navigate(options: { url: string; tabId?: TabId }): Promise<NavigateResult>;
  listChromeTabs(): Promise<ChromeTabListing>;
  readChromeTab(options: { chromeTabId: number }): Promise<ChromeTabRead>;
  navigateChromeTab(options: { url: string; chromeTabId?: number }): Promise<ChromeNavigateResult>;
  softClickChromeTab(options: { chromeTabId: number; selector: string }): Promise<SoftInputResult>;
  softTypeChromeTab(options: {
    chromeTabId: number;
    selector: string;
    text: string;
    submit?: boolean;
  }): Promise<SoftInputResult>;
  storage(kinds: string[], options?: { tabId?: TabId }): Promise<Record<string, unknown>>;
  audit(
    category: AuditCategory,
    options?: { url?: string; tabId?: TabId }
  ): Promise<AuditReport>;
  exportConsole(options?: { tabId?: TabId; allTabs?: boolean }): Promise<ExportResult<ConsoleEntry>>;
  exportNetwork(options?: { tabId?: TabId; allTabs?: boolean }): Promise<ExportResult<NetworkEntry>>;
  readArtifact(kind: "screenshot" | "audit", name: string): Promise<Artifact>;
  listTracked(): Promise<TimelineListing>;
  getTimeline(query: TimelineQuery): Promise<TimelineResult>;
}

/** Talks straight to an embedded connector — no network hop, no discovery. */
export class InProcessConnectorClient implements ConnectorClient {
  #connector: Connector;

  constructor(connector: Connector) {
    this.#connector = connector;
  }

  async console(query: ScopedConsoleQuery): Promise<TabScopedResult<ConsoleEntry>> {
    return this.#connector.queryConsole(query);
  }

  async network(query: ScopedNetworkQuery): Promise<TabScopedResult<NetworkEntry>> {
    return this.#connector.queryNetwork(query);
  }

  async selectedElement(options: { tabId?: TabId } = {}): Promise<unknown> {
    return this.#connector.getSelectedElement(options);
  }

  async page(): Promise<PageInfo> {
    const tabs = this.#connector.listTabs();
    const current = tabs.find((tab) => tab.isCurrent);
    const page = this.#connector.store.getCurrentPage();
    const url = current?.url || page.url;
    return {
      url,
      tabId: this.#connector.getCurrentTabId() ?? page.tabId,
      extensionConnected: this.#connector.hasExtension(),
      connectedTabs: tabs.length,
      ...restrictedPageFields(url),
    };
  }

  async status(): Promise<ConnectorStatus> {
    const tabs = this.#connector.listTabs();
    return {
      version: "2.0.0",
      extensionConnected: this.#connector.hasExtension(),
      connections: tabs.length,
      tabs: tabs.length,
      currentTabId: this.#connector.getCurrentTabId(),
      screenshotDir: this.#connector.screenshotDir,
      counts: {
        console: this.#connector.store.queryConsole({}).total,
        network: this.#connector.store.queryNetwork({}).total,
      },
    };
  }

  async tabs(): Promise<TabListing> {
    const tabs = this.#connector.listTabs();
    return {
      tabs,
      currentTabId: this.#connector.getCurrentTabId(),
      connectedTabs: tabs.length,
    };
  }

  async wipe(options: { tabId?: TabId } = {}): Promise<void> {
    this.#connector.store.wipe(options.tabId);
  }

  async screenshot(options: { name?: string; tabId?: TabId }): Promise<ScreenshotResult> {
    return this.#connector.captureScreenshot(options);
  }

  async refresh(options: { tabId?: TabId } = {}): Promise<void> {
    return this.#connector.refreshTab(options);
  }

  async navigate(options: { url: string; tabId?: TabId }): Promise<NavigateResult> {
    return this.#connector.navigateTab(options);
  }

  listChromeTabs(): Promise<ChromeTabListing> {
    return this.#connector.listChromeTabs();
  }

  readChromeTab(options: { chromeTabId: number }): Promise<ChromeTabRead> {
    return this.#connector.readChromeTab(options);
  }

  navigateChromeTab(options: { url: string; chromeTabId?: number }): Promise<ChromeNavigateResult> {
    return this.#connector.navigateChromeTab(options);
  }

  softClickChromeTab(options: { chromeTabId: number; selector: string }): Promise<SoftInputResult> {
    return this.#connector.softClickChromeTab(options);
  }

  softTypeChromeTab(options: {
    chromeTabId: number;
    selector: string;
    text: string;
    submit?: boolean;
  }): Promise<SoftInputResult> {
    return this.#connector.softTypeChromeTab(options);
  }

  async storage(
    kinds: string[],
    options: { tabId?: TabId } = {}
  ): Promise<Record<string, unknown>> {
    return this.#connector.readStorage(kinds, options);
  }

  async audit(
    category: AuditCategory,
    options: { url?: string; tabId?: TabId } = {}
  ): Promise<AuditReport> {
    return this.#connector.runAudit(category, options);
  }

  async exportConsole(
    options: { tabId?: TabId; allTabs?: boolean } = {}
  ): Promise<ExportResult<ConsoleEntry>> {
    return this.#connector.exportConsole(options);
  }

  async exportNetwork(
    options: { tabId?: TabId; allTabs?: boolean } = {}
  ): Promise<ExportResult<NetworkEntry>> {
    return this.#connector.exportNetwork(options);
  }

  async readArtifact(kind: "screenshot" | "audit", name: string): Promise<Artifact> {
    return this.#connector.readArtifact(kind, name);
  }

  async listTracked(): Promise<TimelineListing> {
    return this.#connector.listTracked();
  }

  async getTimeline(query: TimelineQuery): Promise<TimelineResult> {
    return this.#connector.queryTimeline(query);
  }
}

export interface HttpConnectorClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** Talks to a connector running in another process. */
export class HttpConnectorClient implements ConnectorClient {
  #baseUrl: string;
  #token: string;
  #fetch: typeof fetch;

  constructor(options: HttpConnectorClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #request<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length) url.searchParams.set(key, value.join(","));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.#fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const restricted = restrictedPageErrorFromPayload(payload);
      if (restricted) throw restricted;
      const message =
        typeof payload["error"] === "string" ? payload["error"] : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload as T;
  }

  console(query: ScopedConsoleQuery): Promise<TabScopedResult<ConsoleEntry>> {
    return this.#request("/api/console", { query: query as Record<string, unknown> });
  }

  network(query: ScopedNetworkQuery): Promise<TabScopedResult<NetworkEntry>> {
    return this.#request("/api/network", { query: query as Record<string, unknown> });
  }

  async selectedElement(options: { tabId?: TabId } = {}): Promise<unknown> {
    const result = await this.#request<{ element: unknown }>("/api/selected-element", {
      query: options as Record<string, unknown>,
    });
    return result.element;
  }

  tabs(): Promise<TabListing> {
    return this.#request("/api/tabs");
  }

  page(): Promise<PageInfo> {
    return this.#request("/api/page");
  }

  status(): Promise<ConnectorStatus> {
    return this.#request("/api/status");
  }

  async wipe(options: { tabId?: TabId } = {}): Promise<void> {
    await this.#request("/api/wipe", { method: "POST", body: options });
  }

  screenshot(options: { name?: string; tabId?: TabId }): Promise<ScreenshotResult> {
    return this.#request("/api/screenshot", { method: "POST", body: options });
  }

  async refresh(options: { tabId?: TabId } = {}): Promise<void> {
    await this.#request("/api/refresh", { method: "POST", body: options });
  }

  navigate(options: { url: string; tabId?: TabId }): Promise<NavigateResult> {
    return this.#request("/api/navigate", { method: "POST", body: options });
  }

  listChromeTabs(): Promise<ChromeTabListing> {
    return this.#request("/api/chrome-tabs");
  }

  readChromeTab(options: { chromeTabId: number }): Promise<ChromeTabRead> {
    return this.#request("/api/chrome-tabs/read", { method: "POST", body: options });
  }

  navigateChromeTab(options: { url: string; chromeTabId?: number }): Promise<ChromeNavigateResult> {
    return this.#request("/api/chrome-tabs/navigate", { method: "POST", body: options });
  }

  softClickChromeTab(options: { chromeTabId: number; selector: string }): Promise<SoftInputResult> {
    return this.#request("/api/chrome-tabs/soft-click", { method: "POST", body: options });
  }

  softTypeChromeTab(options: {
    chromeTabId: number;
    selector: string;
    text: string;
    submit?: boolean;
  }): Promise<SoftInputResult> {
    return this.#request("/api/chrome-tabs/soft-type", { method: "POST", body: options });
  }

  async storage(
    kinds: string[],
    options: { tabId?: TabId } = {}
  ): Promise<Record<string, unknown>> {
    const result = await this.#request<{ storage: Record<string, unknown> }>("/api/storage", {
      method: "POST",
      body: { kinds, ...options },
    });
    return result.storage;
  }

  audit(
    category: AuditCategory,
    options: { url?: string; tabId?: TabId } = {}
  ): Promise<AuditReport> {
    return this.#request(`/api/audit/${category}`, { method: "POST", body: options });
  }

  exportConsole(
    options: { tabId?: TabId; allTabs?: boolean } = {}
  ): Promise<ExportResult<ConsoleEntry>> {
    return this.#request("/api/export/console", { query: options as Record<string, unknown> });
  }

  exportNetwork(
    options: { tabId?: TabId; allTabs?: boolean } = {}
  ): Promise<ExportResult<NetworkEntry>> {
    return this.#request("/api/export/network", { query: options as Record<string, unknown> });
  }

  readArtifact(kind: "screenshot" | "audit", name: string): Promise<Artifact> {
    return this.#request(`/api/artifact/${kind}/${encodeURIComponent(name)}`);
  }

  listTracked(): Promise<TimelineListing> {
    return this.#request("/api/timeline");
  }

  getTimeline(query: TimelineQuery): Promise<TimelineResult> {
    return this.#request("/api/timeline/logs", { query: query as Record<string, unknown> });
  }
}
