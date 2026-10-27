import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TimelineQueryError,
  TimelineStore,
  TIMELINE_WINDOW_MS,
  normalizeOrigin,
  stripCredentialText,
} from "../../src/timeline/store";

const NOW = Date.parse("2026-10-27T15:10:00.000Z");
const ORIGIN = "https://billing.example:443";
const SECRET = "super-secret-token";
const COOKIE = "session=abc123secret";

function trackedTab(store: TimelineStore, chromeTabId = 4) {
  store.replaceTargets([
    {
      kind: "tab",
      chromeTabId,
      origin: "https://billing.example/pay",
      url: "https://billing.example/pay",
      title: "Billing",
      enabledAt: NOW - 60_000,
    },
  ]);
}

describe("normalizeOrigin", () => {
  it("writes the default port", () => {
    expect(normalizeOrigin("https://billing.example/pay")).toBe(ORIGIN);
    expect(normalizeOrigin("http://localhost:3000/app")).toBe("http://localhost:3000");
  });

  it("rejects non-http pages", () => {
    expect(normalizeOrigin("chrome://settings")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
  });
});

describe("stripCredentialText", () => {
  it("removes cookie and authorization values", () => {
    const out = stripCredentialText(
      `Cookie: ${COOKIE}\nAuthorization: Bearer ${SECRET}\nstill here`
    );
    expect(out).not.toContain(COOKIE);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("still here");
  });
});

describe("TimelineStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function store(now = NOW) {
    return new TimelineStore({ now: () => now });
  }

  it("lists nothing until a tab or origin is enabled", () => {
    const timeline = store();
    expect(timeline.list().targets).toEqual([]);
    expect(timeline.list().localOnly).toBe(true);
    expect(timeline.list().retentionHours).toBe(8);
  });

  it("returns an empty result for a tab that was never enabled", () => {
    const timeline = store();
    trackedTab(timeline, 4);
    timeline.ingest(consoleEvent(4, "invoice failed"));
    const missed = timeline.query({ chromeTabId: 9 });
    expect(missed.tracked).toBe(false);
    expect(missed.reason).toBe("not-enabled");
    expect(missed.console).toEqual([]);
    expect(missed.network).toEqual([]);
    expect(JSON.stringify(missed)).not.toContain("invoice failed");
  });

  it("does not return another tab's logs", () => {
    const timeline = store();
    trackedTab(timeline, 4);
    timeline.ingest(consoleEvent(4, "invoice failed"));
    trackedTab(timeline, 8);
    timeline.replaceTargets([
      {
        kind: "tab",
        chromeTabId: 4,
        origin: ORIGIN,
        url: "https://billing.example/pay",
        title: "Billing",
        enabledAt: NOW - 60_000,
      },
      {
        kind: "tab",
        chromeTabId: 8,
        origin: "https://other.example:443",
        url: "https://other.example/",
        title: "Other",
        enabledAt: NOW - 60_000,
      },
    ]);
    timeline.ingest(consoleEvent(8, "other tab", "https://other.example/"));
    const billing = timeline.query({ chromeTabId: 4 });
    expect(billing.reason).toBe("ok");
    expect(billing.console.map((entry) => entry.message)).toEqual(["invoice failed"]);
    const other = timeline.query({ chromeTabId: 8 });
    expect(other.console.map((entry) => entry.message)).toEqual(["other tab"]);
  });

  it("queries by origin and by lastMinutes or from/to", () => {
    const timeline = store();
    timeline.replaceTargets([
      { kind: "origin", origin: "https://billing.example/pay", enabledAt: NOW - 120_000 },
    ]);
    expect(timeline.list().targets.map((target) => target.origin)).toEqual([ORIGIN]);
    timeline.ingest(consoleEvent(4, "at 3:00", ORIGIN, NOW - 10 * 60_000));
    timeline.ingest(consoleEvent(4, "at 3:09", ORIGIN, NOW - 60_000));

    const recent = timeline.query({ origin: "https://billing.example", lastMinutes: 5 });
    expect(recent.reason).toBe("ok");
    expect(recent.console.map((entry) => entry.message)).toEqual(["at 3:09"]);

    const earlier = timeline.query({
      origin: ORIGIN,
      from: new Date(NOW - 11 * 60_000).toISOString(),
      to: new Date(NOW - 9 * 60_000).toISOString(),
    });
    expect(earlier.console.map((entry) => entry.message)).toEqual(["at 3:00"]);

    const gap = timeline.query({ origin: ORIGIN, lastMinutes: 1 });
    // 3:09 is one minute ago, so last 1 minute still includes it.
    expect(gap.console.map((entry) => entry.message)).toEqual(["at 3:09"]);
    const quiet = timeline.query({
      chromeTabId: 4,
      from: new Date(NOW - 30_000).toISOString(),
      to: new Date(NOW - 20_000).toISOString(),
    });
    expect(quiet.tracked).toBe(true);
    expect(quiet.reason).toBe("none-in-range");
    expect(quiet.console).toEqual([]);
  });

  it("returns empty when the time is outside the 8-hour window", () => {
    const timeline = store();
    trackedTab(timeline);
    timeline.ingest(consoleEvent(4, "invoice failed"));
    const outside = timeline.query({
      chromeTabId: 4,
      from: new Date(NOW - TIMELINE_WINDOW_MS - 2 * 60 * 60_000).toISOString(),
      to: new Date(NOW - TIMELINE_WINDOW_MS - 60 * 60_000).toISOString(),
    });
    expect(outside.tracked).toBe(true);
    expect(outside.reason).toBe("outside-window");
    expect(outside.console).toEqual([]);
    expect(outside.network).toEqual([]);
    expect(JSON.stringify(outside)).not.toContain("invoice failed");
  });

  it("drops entries once they age out of the window", () => {
    let now = NOW;
    const timeline = new TimelineStore({ now: () => now });
    trackedTab(timeline);
    timeline.ingest(consoleEvent(4, "invoice failed"));
    now = NOW + TIMELINE_WINDOW_MS + 1;
    const aged = timeline.query({ chromeTabId: 4, lastMinutes: 10 });
    expect(aged.console).toEqual([]);
    expect(aged.reason).toBe("none-in-range");
    expect(JSON.stringify(aged)).not.toContain("invoice failed");
  });

  it("strips cookies and Authorization before storage", () => {
    const timeline = store();
    trackedTab(timeline);
    expect(
      timeline.ingest({
        kind: "network",
        chromeTabId: 4,
        origin: ORIGIN,
        url: "https://billing.example/api/pay",
        method: "POST",
        status: 500,
        timestamp: NOW,
        requestHeaders: {
          Authorization: `Bearer ${SECRET}`,
          Cookie: COOKIE,
          "Set-Cookie": "sid=secret-sid",
          "Content-Type": "application/json",
        },
        requestBody: `{"authorization":"Bearer ${SECRET}","amount":10}`,
      })
    ).toBe(true);
    timeline.ingest(consoleEvent(4, `Cookie: ${COOKIE}`));
    const result = timeline.query({ chromeTabId: 4 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(COOKIE);
    expect(serialized).not.toContain("secret-sid");
    expect(result.network[0]?.requestHeaders?.["Content-Type"]).toBe("application/json");
    expect(result.network[0]?.requestHeaders).not.toHaveProperty("Authorization");
    expect(result.network[0]?.requestHeaders).not.toHaveProperty("Cookie");
    expect(result.network[0]?.requestBody).toContain("amount");
  });

  it("does not store events for a target that is not enabled", () => {
    const timeline = store();
    expect(timeline.ingest(consoleEvent(4, "too early"))).toBe(false);
    trackedTab(timeline);
    timeline.ingest(consoleEvent(4, "kept"));
    timeline.replaceTargets([]);
    expect(timeline.list().targets).toEqual([]);
    expect(timeline.ingest(consoleEvent(4, "after disable"))).toBe(false);
    const result = timeline.query({ chromeTabId: 4 });
    expect(result.console.map((entry) => entry.message)).toEqual(["kept"]);
  });

  it("refuses a query that does not name a tab or origin", () => {
    const timeline = store();
    expect(() => timeline.query({})).toThrow(TimelineQueryError);
    expect(() => timeline.query({ lastMinutes: 5, from: new Date(NOW).toISOString() })).toThrow(
      /not both/
    );
  });

  it("persists only the redacted log, owner-readable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-timeline-"));
    dirs.push(dir);
    const timeline = new TimelineStore({ dir, now: () => NOW });
    trackedTab(timeline);
    timeline.ingest({
      kind: "network",
      chromeTabId: 4,
      origin: ORIGIN,
      url: "https://billing.example/api/pay",
      method: "GET",
      status: 200,
      timestamp: NOW,
      requestHeaders: { Authorization: `Bearer ${SECRET}`, Accept: "application/json" },
    });
    timeline.flush();
    const file = path.join(dir, "timeline.json");
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("application/json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const restored = new TimelineStore({ dir, now: () => NOW });
    expect(restored.query({ chromeTabId: 4 }).network).toHaveLength(1);
    expect(restored.list().targets[0]?.chromeTabId).toBe(4);
  });

  it("starts empty when the file is unreadable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-timeline-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "timeline.json"), "{not json", { mode: 0o600 });
    const timeline = new TimelineStore({ dir, now: () => NOW });
    expect(timeline.list().targets).toEqual([]);
    expect(timeline.query({ chromeTabId: 4 }).reason).toBe("not-enabled");
  });
});

function consoleEvent(
  chromeTabId: number,
  message: string,
  origin = ORIGIN,
  timestamp = NOW
) {
  return {
    kind: "console" as const,
    chromeTabId,
    origin,
    url: "https://billing.example/pay",
    level: "error",
    message,
    timestamp,
  };
}
