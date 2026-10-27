/**
 * Opt-in tab timeline (AGE-813).
 *
 * Nothing is recorded until the user enables a tab or an origin. Entries live
 * on this machine for a rolling 8 hours, then they are dropped. Cookie and
 * Authorization values are removed before anything is stored. A query for a
 * target that was never enabled, or a time entirely outside the window,
 * returns an empty result — it does not borrow the DevTools log buffer.
 */

import fs from "node:fs";
import path from "node:path";

import { redactHeaders, redactSecretsInString, REDACTED } from "../util/redact.js";
import { logger } from "../util/logger.js";

export const TIMELINE_WINDOW_MS = 8 * 60 * 60 * 1000;
export const TIMELINE_RETENTION_HOURS = 8;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_PER_TAB = 2000;
const STRING_LIMIT = 2000;
const FILE_NAME = "timeline.json";

const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;

export type TimelineReason = "ok" | "not-enabled" | "outside-window" | "none-in-range";

export interface TimelineTarget {
  kind: "tab" | "origin";
  chromeTabId: number | null;
  origin: string;
  url: string;
  title: string;
  enabledAt: number;
  enabled: boolean;
}

export interface TimelineConsoleEntry {
  kind: "console";
  chromeTabId: number;
  origin: string;
  url: string;
  level: string;
  message: string;
  timestamp: number;
}

export interface TimelineNetworkEntry {
  kind: "network";
  chromeTabId: number;
  origin: string;
  url: string;
  method: string;
  status: number;
  timestamp: number;
  startedAt?: number;
  durationMs?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
}

export type TimelineEntry = TimelineConsoleEntry | TimelineNetworkEntry;

export interface TimelineQuery {
  chromeTabId?: number;
  origin?: string;
  from?: string | number;
  to?: string | number;
  lastMinutes?: number;
  limit?: number;
}

export interface TimelineResult {
  tracked: boolean;
  reason: TimelineReason;
  chromeTabId: number | null;
  origin: string | null;
  from: string;
  to: string;
  windowStart: string;
  retentionHours: number;
  localOnly: true;
  clipped: boolean;
  console: TimelineConsoleEntry[];
  network: TimelineNetworkEntry[];
  consoleTotal: number;
  networkTotal: number;
  truncated: boolean;
}

export interface TimelineListing {
  retentionHours: number;
  windowStart: string;
  localOnly: true;
  targets: TimelineTarget[];
}

export class TimelineQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineQueryError";
  }
}

export interface TimelineStoreOptions {
  /** Directory for timeline.json. Omit to keep the log in memory only. */
  dir?: string;
  now?: () => number;
}

interface Selector {
  chromeTabId?: number;
  origin?: string;
}

/**
 * Same origin shape the extension uses: scheme, lower-case host, and port,
 * with 80 and 443 written out. A value that is not http(s) is not an origin.
 */
export function normalizeOrigin(input: string): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

function clipString(value: string): string {
  const scrubbed = stripCredentialText(redactSecretsInString(value));
  if (scrubbed.length <= STRING_LIMIT) return scrubbed;
  return `${scrubbed.slice(0, STRING_LIMIT)}... (truncated)`;
}

/**
 * Removes Cookie and Authorization material from free text before it is stored.
 * The value runs to the end of the line so a scheme plus token, or a cookie
 * pair, cannot leave a second word behind.
 */
export function stripCredentialText(value: string): string {
  if (!value) return value;
  return value
    .replace(
      /\b((?:proxy-)?authorization|cookie|set-cookie)\b["']?(\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\n\r]*)/gi,
      `$1$2${REDACTED}`
    )
    .replace(/\b(Bearer|Basic|Token|Digest)\s+\S+/gi, `$1 ${REDACTED}`);
}

function stripCredentialHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADER.test(name)) continue;
    if (typeof value === "string") kept[name] = value;
    else if (Array.isArray(value)) kept[name] = value.map((item) => String(item)).join(", ");
    else if (value !== undefined && value !== null) kept[name] = String(value);
  }
  const redacted = redactHeaders(kept);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(redacted)) {
    if (CREDENTIAL_HEADER.test(name)) continue;
    out[name] = clipString(value);
  }
  return Object.keys(out).length ? out : undefined;
}

function targetKey(target: { kind: string; chromeTabId?: number | null; origin?: string }): string {
  if (target.kind === "tab" && typeof target.chromeTabId === "number") {
    return `tab:${target.chromeTabId}`;
  }
  return `origin:${target.origin ?? ""}`;
}

function emptyResult(
  partial: Pick<TimelineResult, "chromeTabId" | "origin" | "from" | "to" | "windowStart" | "clipped"> & {
    tracked: boolean;
    reason: TimelineReason;
  }
): TimelineResult {
  return {
    ...partial,
    retentionHours: TIMELINE_RETENTION_HOURS,
    localOnly: true,
    console: [],
    network: [],
    consoleTotal: 0,
    networkTotal: 0,
    truncated: false,
  };
}

export class TimelineStore {
  #dir?: string;
  #now: () => number;
  #targets: TimelineTarget[] = [];
  #console: TimelineConsoleEntry[] = [];
  #network: TimelineNetworkEntry[] = [];
  #flushTimer: NodeJS.Timeout | null = null;

  constructor(options: TimelineStoreOptions = {}) {
    this.#dir = options.dir;
    this.#now = options.now ?? Date.now;
    this.#load();
  }

  get dir(): string | undefined {
    return this.#dir;
  }

  list(now = this.#now()): TimelineListing {
    this.#prune(now);
    return {
      retentionHours: TIMELINE_RETENTION_HOURS,
      windowStart: new Date(now - TIMELINE_WINDOW_MS).toISOString(),
      localOnly: true,
      targets: this.#targets
        .filter((target) => target.enabled)
        .map((target) => ({ ...target }))
        .sort((a, b) => a.enabledAt - b.enabledAt || targetKey(a).localeCompare(targetKey(b))),
    };
  }

  /**
   * Replaces the set of targets the user currently has on. Targets that drop
   * out are disabled, not forgotten, so a later query can still find the logs
   * they already produced. Unknown shapes are ignored.
   */
  replaceTargets(raw: unknown, now = this.#now()): void {
    if (!Array.isArray(raw)) return;
    const incoming: TimelineTarget[] = [];
    for (const item of raw) {
      const target = this.#normalizeTarget(item, now);
      if (target) incoming.push(target);
    }
    const seen = new Set<string>();
    for (const next of incoming) {
      const key = targetKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = this.#targets.find((target) => targetKey(target) === key);
      if (existing) {
        existing.enabled = true;
        existing.origin = next.origin || existing.origin;
        existing.url = next.url || existing.url;
        existing.title = next.title || existing.title;
        if (next.enabledAt < existing.enabledAt) existing.enabledAt = next.enabledAt;
      } else {
        this.#targets.push(next);
      }
    }
    for (const target of this.#targets) {
      if (!seen.has(targetKey(target))) target.enabled = false;
    }
    this.#scheduleFlush();
  }

  /** Stores one event when its tab or origin is currently enabled. */
  ingest(raw: unknown, now = this.#now()): boolean {
    const entry = this.#normalizeEntry(raw, now);
    if (!entry) return false;
    if (!this.#enabledFor(entry)) return false;
    if (entry.timestamp < now - TIMELINE_WINDOW_MS) return false;
    if (entry.kind === "console") {
      this.#console.push(entry);
      this.#evict(this.#console, entry.chromeTabId);
    } else {
      this.#network.push(entry);
      this.#evict(this.#network, entry.chromeTabId);
    }
    this.#prune(now);
    this.#scheduleFlush();
    return true;
  }

  query(query: TimelineQuery, now = this.#now()): TimelineResult {
    this.#prune(now);
    const windowStart = now - TIMELINE_WINDOW_MS;
    const range = this.#range(query, now, windowStart);
    const selector = this.#selector(query);
    const frame = {
      chromeTabId: selector.chromeTabId ?? null,
      origin: selector.origin ?? null,
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      windowStart: new Date(windowStart).toISOString(),
      clipped: false,
    };

    if (!this.#wasTracked(selector)) {
      return emptyResult({ ...frame, tracked: false, reason: "not-enabled" });
    }
    if (range.to < windowStart || range.from > now) {
      return emptyResult({ ...frame, tracked: true, reason: "outside-window" });
    }

    const start = Math.max(range.from, windowStart);
    const end = Math.min(range.to, now);
    const clipped = start !== range.from || end !== range.to;
    const limit = this.#limit(query.limit);
    const consoleMatches = this.#console.filter(
      (entry) => this.#matches(entry, selector) && entry.timestamp >= start && entry.timestamp <= end
    );
    const networkMatches = this.#network.filter(
      (entry) => this.#matches(entry, selector) && entry.timestamp >= start && entry.timestamp <= end
    );
    const consolePage = page(consoleMatches, limit);
    const networkPage = page(networkMatches, limit);
    if (consoleMatches.length === 0 && networkMatches.length === 0) {
      return emptyResult({
        ...frame,
        clipped,
        tracked: true,
        reason: "none-in-range",
      });
    }
    return {
      tracked: true,
      reason: "ok",
      chromeTabId: selector.chromeTabId ?? null,
      origin: selector.origin ?? null,
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      windowStart: new Date(windowStart).toISOString(),
      retentionHours: TIMELINE_RETENTION_HOURS,
      localOnly: true,
      clipped,
      console: consolePage.entries,
      network: networkPage.entries,
      consoleTotal: consoleMatches.length,
      networkTotal: networkMatches.length,
      truncated: consolePage.truncated || networkPage.truncated,
    };
  }

  flush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#write();
  }

  #selector(query: TimelineQuery): Selector {
    const selector: Selector = {};
    if (query.chromeTabId !== undefined) {
      if (!Number.isInteger(query.chromeTabId) || query.chromeTabId <= 0) {
        throw new TimelineQueryError("chromeTabId must be a positive integer.");
      }
      selector.chromeTabId = query.chromeTabId;
    }
    if (query.origin !== undefined) {
      if (typeof query.origin !== "string" || !query.origin.trim()) {
        throw new TimelineQueryError("origin must be an http(s) origin.");
      }
      const origin = normalizeOrigin(query.origin);
      if (!origin) throw new TimelineQueryError("origin must be an http(s) origin.");
      selector.origin = origin;
    }
    if (selector.chromeTabId === undefined && selector.origin === undefined) {
      throw new TimelineQueryError(
        "Pass chromeTabId or origin. This does not guess a tab from the DevTools buffer."
      );
    }
    return selector;
  }

  #range(query: TimelineQuery, now: number, windowStart: number): { from: number; to: number } {
    const hasFrom = query.from !== undefined;
    const hasTo = query.to !== undefined;
    const hasLast = query.lastMinutes !== undefined;
    if (hasLast && (hasFrom || hasTo)) {
      throw new TimelineQueryError("Pass lastMinutes or from/to, not both.");
    }
    if (hasLast) {
      if (!Number.isInteger(query.lastMinutes) || (query.lastMinutes as number) < 1) {
        throw new TimelineQueryError("lastMinutes must be a positive integer.");
      }
      return { from: now - (query.lastMinutes as number) * 60_000, to: now };
    }
    const from = hasFrom ? parseTime(query.from as string | number, "from") : windowStart;
    const to = hasTo ? parseTime(query.to as string | number, "to") : now;
    if (from > to) throw new TimelineQueryError("from is after to.");
    return { from, to };
  }

  #limit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new TimelineQueryError(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
    }
    return limit;
  }

  #wasTracked(selector: Selector): boolean {
    const tab = selector.chromeTabId;
    const origin = selector.origin;
    if (tab !== undefined && origin !== undefined) {
      return this.#tabKnown(tab) || this.#originKnown(origin);
    }
    if (tab !== undefined) return this.#tabKnown(tab);
    return origin !== undefined && this.#originKnown(origin);
  }

  #tabKnown(chromeTabId: number): boolean {
    return (
      this.#targets.some((target) => target.kind === "tab" && target.chromeTabId === chromeTabId) ||
      this.#console.some((entry) => entry.chromeTabId === chromeTabId) ||
      this.#network.some((entry) => entry.chromeTabId === chromeTabId)
    );
  }

  #originKnown(origin: string): boolean {
    return (
      this.#targets.some((target) => target.origin === origin) ||
      this.#console.some((entry) => entry.origin === origin) ||
      this.#network.some((entry) => entry.origin === origin)
    );
  }

  #enabledFor(entry: TimelineEntry): boolean {
    if (
      this.#targets.some(
        (target) => target.enabled && target.kind === "tab" && target.chromeTabId === entry.chromeTabId
      )
    ) {
      return true;
    }
    return this.#targets.some(
      (target) => target.enabled && target.kind === "origin" && target.origin === entry.origin
    );
  }

  #matches(entry: TimelineEntry, selector: Selector): boolean {
    if (selector.chromeTabId !== undefined && entry.chromeTabId !== selector.chromeTabId) return false;
    if (selector.origin !== undefined && entry.origin !== selector.origin) return false;
    return true;
  }

  #normalizeTarget(raw: unknown, now: number): TimelineTarget | null {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Record<string, unknown>;
    const kind = source["kind"];
    const enabledAt = typeof source["enabledAt"] === "number" && Number.isFinite(source["enabledAt"])
      ? source["enabledAt"]
      : now;
    if (kind === "tab") {
      const chromeTabId = source["chromeTabId"];
      if (typeof chromeTabId !== "number" || !Number.isInteger(chromeTabId) || chromeTabId <= 0) {
        return null;
      }
      const origin = typeof source["origin"] === "string" ? normalizeOrigin(source["origin"]) ?? "" : "";
      return {
        kind: "tab",
        chromeTabId,
        origin,
        url: typeof source["url"] === "string" ? clipString(source["url"]) : "",
        title: typeof source["title"] === "string" ? clipString(source["title"]) : "",
        enabledAt,
        enabled: true,
      };
    }
    if (kind === "origin") {
      const origin = typeof source["origin"] === "string" ? normalizeOrigin(source["origin"]) : null;
      if (!origin) return null;
      return {
        kind: "origin",
        chromeTabId: null,
        origin,
        url: "",
        title: "",
        enabledAt,
        enabled: true,
      };
    }
    return null;
  }

  #normalizeEntry(raw: unknown, now: number): TimelineEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Record<string, unknown>;
    const chromeTabId = source["chromeTabId"];
    if (typeof chromeTabId !== "number" || !Number.isInteger(chromeTabId) || chromeTabId <= 0) {
      return null;
    }
    const originSource = typeof source["origin"] === "string" ? source["origin"] : "";
    const urlSource = typeof source["url"] === "string" ? source["url"] : "";
    const origin = normalizeOrigin(originSource) ?? normalizeOrigin(urlSource);
    if (!origin) return null;
    let timestamp = typeof source["timestamp"] === "number" && Number.isFinite(source["timestamp"])
      ? source["timestamp"]
      : now;
    if (timestamp > now) timestamp = now;

    if (source["kind"] === "console") {
      const level = typeof source["level"] === "string" && source["level"].trim() ? source["level"] : "log";
      const message = typeof source["message"] === "string" ? source["message"] : "";
      return {
        kind: "console",
        chromeTabId,
        origin,
        url: clipString(urlSource || origin),
        level: clipString(level).slice(0, 32),
        message: clipString(message),
        timestamp,
      };
    }
    if (source["kind"] === "network") {
      const method = typeof source["method"] === "string" && source["method"].trim()
        ? source["method"].toUpperCase().slice(0, 16)
        : "GET";
      const status = typeof source["status"] === "number" && Number.isFinite(source["status"])
        ? Math.trunc(source["status"])
        : 0;
      const entry: TimelineNetworkEntry = {
        kind: "network",
        chromeTabId,
        origin,
        url: clipString(urlSource || origin),
        method,
        status,
        timestamp,
      };
      if (typeof source["startedAt"] === "number" && Number.isFinite(source["startedAt"])) {
        entry.startedAt = source["startedAt"];
      }
      if (typeof source["durationMs"] === "number" && Number.isFinite(source["durationMs"])) {
        entry.durationMs = source["durationMs"];
      }
      if (typeof source["error"] === "string" && source["error"]) entry.error = clipString(source["error"]);
      const headers = asRecord(source["requestHeaders"]);
      const stripped = headers ? stripCredentialHeaders(headers) : undefined;
      if (stripped) entry.requestHeaders = stripped;
      if (typeof source["requestBody"] === "string" && source["requestBody"]) {
        entry.requestBody = clipString(source["requestBody"]);
      }
      return entry;
    }
    return null;
  }

  #evict(entries: TimelineEntry[], chromeTabId: number): void {
    let count = 0;
    for (const entry of entries) {
      if (entry.chromeTabId === chromeTabId) count += 1;
    }
    let extra = count - MAX_PER_TAB;
    if (extra <= 0) return;
    for (let i = 0; i < entries.length && extra > 0; i++) {
      if (entries[i]?.chromeTabId === chromeTabId) {
        entries.splice(i, 1);
        i -= 1;
        extra -= 1;
      }
    }
  }

  #prune(now: number): void {
    const cutoff = now - TIMELINE_WINDOW_MS;
    this.#console = this.#console.filter((entry) => entry.timestamp >= cutoff);
    this.#network = this.#network.filter((entry) => entry.timestamp >= cutoff);
    this.#targets = this.#targets.filter((target) => {
      if (target.enabled) return true;
      if (target.enabledAt >= cutoff) return true;
      if (target.kind === "tab" && target.chromeTabId !== null) {
        return (
          this.#console.some((entry) => entry.chromeTabId === target.chromeTabId) ||
          this.#network.some((entry) => entry.chromeTabId === target.chromeTabId)
        );
      }
      return (
        this.#console.some((entry) => entry.origin === target.origin) ||
        this.#network.some((entry) => entry.origin === target.origin)
      );
    });
  }

  #scheduleFlush(): void {
    if (!this.#dir) return;
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#write();
    }, 200);
    this.#flushTimer.unref?.();
  }

  #file(): string | null {
    return this.#dir ? path.join(this.#dir, FILE_NAME) : null;
  }

  #load(): void {
    const file = this.#file();
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        targets?: unknown;
        console?: unknown;
        network?: unknown;
      };
      const now = this.#now();
      if (Array.isArray(parsed.targets)) {
        for (const item of parsed.targets) {
          const target = this.#normalizeTarget(item, now);
          if (!target) continue;
          if (item && typeof item === "object" && (item as { enabled?: unknown }).enabled === false) {
            target.enabled = false;
          }
          this.#targets.push(target);
        }
      }
      if (Array.isArray(parsed.console)) {
        for (const item of parsed.console) {
          const entry = this.#normalizeEntry(item, now);
          if (entry && entry.kind === "console") this.#console.push(entry);
        }
      }
      if (Array.isArray(parsed.network)) {
        for (const item of parsed.network) {
          const entry = this.#normalizeEntry(item, now);
          if (entry && entry.kind === "network") this.#network.push(entry);
        }
      }
      this.#prune(now);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") logger.warn("Could not read timeline file:", error);
      this.#targets = [];
      this.#console = [];
      this.#network = [];
    }
  }

  #write(): void {
    const file = this.#file();
    if (!file || !this.#dir) return;
    try {
      fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const body = JSON.stringify(
        {
          version: 1,
          targets: this.#targets,
          console: this.#console,
          network: this.#network,
        },
        null,
        2
      );
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      logger.warn("Could not write timeline file:", error);
    }
  }
}

function parseTime(value: string | number, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(value.trim())) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new TimelineQueryError(`${label} must be an ISO time or epoch milliseconds.`);
}

function page<T extends { timestamp: number }>(
  entries: T[],
  limit: number
): { entries: T[]; truncated: boolean } {
  const ordered = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  if (ordered.length <= limit) return { entries: ordered, truncated: false };
  return { entries: ordered.slice(ordered.length - limit), truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
