import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The extension's opt-in timeline, loaded from the files that ship.
 * Capture must not attach the debugger or read document.cookie.
 */

const root = path.resolve(fileURLToPath(new URL("../../../chrome-extension", import.meta.url)));

interface TimelineApi {
  emptyState(): { tabs: Record<string, unknown>; origins: Record<string, unknown> };
  isTracked(tab: { id?: number; url?: string }, state: unknown): boolean;
  prepareEvent(entry: Record<string, unknown>, tab: { id?: number; url?: string }): any;
  targetsFromState(state: unknown): unknown[];
  installCapture: () => void;
  installBridge: () => void;
  stripCredentialHeaders(headers: Record<string, string>): Record<string, string>;
}

let timeline: TimelineApi;

beforeAll(() => {
  const source = ["shared.js", "gates.js", "timeline.js"]
    .map((name) => fs.readFileSync(path.join(root, name), "utf8"))
    .join("\n");
  const loaded = new Function(`${source}\nreturn BTMCP_TIMELINE;`) as () => TimelineApi;
  timeline = loaded();
});

describe("timeline opt-in", () => {
  it("tracks nothing until a tab or origin is enabled", () => {
    const state = timeline.emptyState();
    const tab = { id: 4, url: "https://billing.example/pay" };
    expect(timeline.isTracked(tab, state)).toBe(false);
    state.tabs["4"] = { origin: "https://billing.example:443", url: "", title: "", enabledAt: 1 };
    expect(timeline.isTracked(tab, state)).toBe(true);
    expect(timeline.isTracked({ id: 5, url: "https://billing.example/pay" }, state)).toBe(false);
    state.origins["https://billing.example:443"] = { enabledAt: 1 };
    expect(timeline.isTracked({ id: 5, url: "https://billing.example/pay" }, state)).toBe(true);
    expect(timeline.isTracked({ id: 5, url: "https://other.example/" }, state)).toBe(false);
  });

  it("attributes the event to the real tab and strips credentials", () => {
    const prepared = timeline.prepareEvent(
      {
        kind: "network",
        chromeTabId: 999,
        url: "https://billing.example/api/pay",
        method: "POST",
        status: 500,
        requestHeaders: {
          Authorization: "Bearer super-secret-token",
          Cookie: "session=abc123secret",
          "Content-Type": "application/json",
        },
      },
      { id: 4, url: "https://billing.example/pay" }
    );
    expect(prepared.chromeTabId).toBe(4);
    expect(prepared.origin).toBe("https://billing.example:443");
    const serialized = JSON.stringify(prepared);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("abc123secret");
    expect(prepared.requestHeaders["Content-Type"]).toBe("application/json");
    expect(prepared.requestHeaders.Authorization).toBeUndefined();
    expect(prepared.requestHeaders.Cookie).toBeUndefined();
  });

  it("does not use the debugger or document.cookie", () => {
    const source = fs.readFileSync(path.join(root, "timeline.js"), "utf8");
    const worker = fs.readFileSync(path.join(root, "worker.js"), "utf8");
    const capture = `${timeline.installCapture.toString()}\n${timeline.installBridge.toString()}`;
    expect(capture).not.toMatch(/chrome\.debugger|debugger\.attach|document\.cookie/);
    expect(source).not.toMatch(/chrome\.debugger|debugger\.attach|document\.cookie/);
    expect(worker).not.toMatch(/chrome\.debugger|debugger\.attach/);
    expect(source).toMatch(/Record|8-hour|Cookie/);
  });
});

describe("page capture hook", () => {
  it("records console and fetch without cookie or authorization", async () => {
    const events: Array<{ entry: Record<string, unknown> }> = [];
    const sandbox: Record<string, unknown> = {
      Date,
      JSON,
      Array,
      String,
      Object,
      Error,
      Promise,
    };
    sandbox["globalThis"] = sandbox;
    sandbox["console"] = {
      log: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
    sandbox["addEventListener"] = () => undefined;
    sandbox["postMessage"] = (data: { entry: Record<string, unknown> }) => {
      events.push(data);
    };
    sandbox["location"] = { href: "https://billing.example/pay", origin: "https://billing.example" };
    sandbox["fetch"] = async () => ({ status: 201 });
    vm.createContext(sandbox);
    vm.runInContext(`(${timeline.installCapture.toString()})()`, sandbox);

    (sandbox["console"] as { log: (...args: unknown[]) => void }).log("invoice failed");
    await (sandbox["fetch"] as (url: string, init: unknown) => Promise<unknown>)(
      "https://billing.example/api/pay",
      {
        method: "POST",
        headers: { Authorization: "Bearer super-secret-token", "Content-Type": "application/json" },
        body: "amount=10",
      }
    );

    expect(events.map((event) => event.entry["kind"])).toEqual(["console", "network"]);
    expect(events[0]?.entry["message"]).toBe("invoice failed");
    const network = events[1]?.entry;
    expect(network?.["status"]).toBe(201);
    const headers = network?.["requestHeaders"] as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBeUndefined();
    expect(JSON.stringify(network)).not.toContain("super-secret-token");
  });
});
