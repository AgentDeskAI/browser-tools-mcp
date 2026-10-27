import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(fileURLToPath(new URL("../../../chrome-extension", import.meta.url)));

function loadExtension(chromeApi: Record<string, unknown>, documentMock?: Record<string, unknown>) {
  const context: Record<string, unknown> = {
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    globalThis: {},
    api: chromeApi,
    document: documentMock,
    location: { hostname: "127.0.0.1" },
    HTMLInputElement: class HTMLInputElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    Event: class Event {
      type: string;
      bubbles: boolean;
      constructor(type: string, init: { bubbles?: boolean } = {}) {
        this.type = type;
        this.bubbles = init.bubbles === true;
      }
    },
    MouseEvent: class MouseEvent {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    PointerEvent: class PointerEvent {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
  };
  context["globalThis"] = context;
  vm.createContext(context);
  for (const file of ["gates.js", "tab-safety.js", "tab-page.js", "tab-actions.js"]) {
    vm.runInContext(fs.readFileSync(path.join(extensionDir, file), "utf8"), context);
  }
  return context as {
    BTMCP_SAFETY: {
      install: (api: unknown) => void;
      snapshot: () => { debuggerCalls: number; focusChanges: number };
      tabsUpdate: (api: unknown, tabId: number, props: { url: string; active: boolean }) => Promise<unknown>;
    };
    BTMCP_TABS: {
      list: (api: unknown, message: unknown, respond: (id: string, payload: Record<string, unknown>) => void) => Promise<void>;
      navigateChrome: (api: unknown, message: unknown, respond: (id: string, payload: Record<string, unknown>) => void) => Promise<void>;
      read: (api: unknown, message: unknown, respond: (id: string, payload: Record<string, unknown>) => void) => Promise<void>;
      soft: (api: unknown, message: unknown, respond: (id: string, payload: Record<string, unknown>) => void) => Promise<void>;
    };
    btmcpScrubText: (value: string) => string;
    btmcpSoftAct: (command: Record<string, unknown>) => { outcome: string; reason: string | null; trusted: boolean };
    btmcpReadPage: () => { headings: unknown[]; excerpt: string };
  };
}

function storageArea(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    get(key: string | string[], callback: (stored: Record<string, unknown>) => void) {
      const keys = Array.isArray(key) ? key : [key];
      const stored: Record<string, unknown> = {};
      for (const name of keys) stored[name] = data[name];
      callback(stored);
    },
    set(value: Record<string, unknown>, callback?: () => void) {
      Object.assign(data, value);
      callback?.();
    },
  };
}

describe("tab safety wrapper", () => {
  it("counts debugger calls and refuses to activate a tab or focus a window", async () => {
    const calls: string[] = [];
    const api = {
      debugger: {
        attach: () => {
          calls.push("attach");
        },
      },
      tabs: {
        update: (id: number, props: unknown) => {
          calls.push(`update:${id}:${JSON.stringify(props)}`);
          return Promise.resolve(props);
        },
        create: () => Promise.resolve({ id: 1 }),
      },
      windows: {
        update: () => {
          calls.push("windows.update");
          return Promise.resolve();
        },
      },
    };
    const loaded = loadExtension(api);
    loaded.BTMCP_SAFETY.install(api);
    api.debugger.attach();
    expect(loaded.BTMCP_SAFETY.snapshot().debuggerCalls).toBe(1);
    expect(calls).toContain("attach");
    expect(() => api.tabs.update(3, { url: "http://127.0.0.1/", active: true })).toThrow(/focus/);
    expect(() => api.windows.update(1, { focused: true })).toThrow(/focus/);
    expect(calls.some((call) => call.startsWith("update:"))).toBe(false);
    expect(calls).not.toContain("windows.update");
    await loaded.BTMCP_SAFETY.tabsUpdate(api, 3, { url: "http://127.0.0.1/next", active: false });
    expect(calls).toContain('update:3:{"url":"http://127.0.0.1/next","active":false}');
    expect(loaded.BTMCP_SAFETY.snapshot().focusChanges).toBe(2);
  });
});

describe("chrome.tabs actions", () => {
  function apiFor(tabs: Record<number, Record<string, unknown>>, windows: Record<string, unknown>[]) {
    const calls: { method: string; props?: unknown }[] = [];
    const api = {
      storage: {
        session: storageArea({ btmcpPopupSwitch: true }),
        local: storageArea({ btmcpExcludeOrigins: [] }),
      },
      tabs: {
        get: async (id: number) => tabs[id],
        update: async (id: number, props: Record<string, unknown>) => {
          calls.push({ method: "tabs.update", props });
          return { ...tabs[id], ...props };
        },
        create: async (props: Record<string, unknown>) => {
          calls.push({ method: "tabs.create", props });
          return { id: 20, windowId: props["windowId"], url: props["url"], active: props["active"] };
        },
        onCreated: { addListener() {}, removeListener() {} },
        onUpdated: {
          addListener(listener: (id: number, change: { status: string }, tab: { url?: string }) => void) {
            listener(20, { status: "complete" }, { url: "http://127.0.0.1:4000/" });
          },
          removeListener() {},
        },
      },
      windows: {
        getAll: async () => windows,
        getLastFocused: async () => windows.find((win) => win["focused"]) ?? windows[0],
        update: async () => {
          calls.push({ method: "windows.update" });
        },
      },
      permissions: { contains: async () => true },
      scripting: {
        executeScript: async () => [{ result: { title: "Hi", headings: [{ level: 1, text: "Hi" }], excerpt: "Hello", snapshot: [] } }],
      },
      debugger: { attach() { calls.push({ method: "debugger.attach" }); } },
    };
    return { api, calls };
  }

  it("lists normal windows and skips incognito without touching the debugger or focus", async () => {
    const { api, calls } = apiFor({}, [
      {
        id: 1,
        focused: true,
        type: "normal",
        incognito: false,
        tabs: [{ id: 4, windowId: 1, url: "http://127.0.0.1:3000/", title: "Local", active: true, discarded: false, lastAccessed: 5 }],
      },
      { id: 2, focused: false, type: "normal", incognito: true, tabs: [{ id: 9, windowId: 2, url: "https://secret.example/", title: "Secret" }] },
    ]);
    const loaded = loadExtension(api);
    loaded.BTMCP_SAFETY.install(api);
    let result: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.list(api, { requestId: "1" }, (_id, payload) => {
      result = payload;
    });
    expect(result["ok"]).toBe(true);
    const windows = result["windows"] as { tabs: { chromeTabId: number }[] }[];
    expect(windows).toHaveLength(1);
    expect(windows[0]?.tabs[0]?.chromeTabId).toBe(4);
    expect(JSON.stringify(result)).not.toContain("secret.example");
    expect(calls).toEqual([]);
    expect((result["safety"] as { debuggerCalls: number; focusChanges: number }).debuggerCalls).toBe(0);
  });

  it("refuses background navigate outside the visible window and does not activate a tab", async () => {
    const { api, calls } = apiFor(
      { 8: { id: 8, windowId: 2, url: "http://127.0.0.1:3000/", discarded: false, incognito: false } },
      [
        { id: 1, focused: true, type: "normal", incognito: false, tabs: [] },
        { id: 2, focused: false, type: "normal", incognito: false, tabs: [] },
      ]
    );
    const loaded = loadExtension(api);
    loaded.BTMCP_SAFETY.install(api);
    let result: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.navigateChrome(
      api,
      { requestId: "2", chromeTabId: 8, url: "http://127.0.0.1:3000/next", approvedUrl: "http://127.0.0.1:3000/" },
      (_id, payload) => {
        result = payload;
      }
    );
    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toMatch(/visible window/);
    expect(calls).toEqual([]);
  });

  it("opens a background tab in the visible window with active false", async () => {
    const { api, calls } = apiFor({}, [{ id: 1, focused: true, type: "normal", incognito: false, tabs: [] }]);
    const loaded = loadExtension(api);
    loaded.BTMCP_SAFETY.install(api);
    let result: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.navigateChrome(
      api,
      { requestId: "3", create: true, url: "http://127.0.0.1:4000/" },
      (_id, payload) => {
        result = payload;
      }
    );
    expect(result["ok"]).toBe(true);
    expect(result["created"]).toBe(true);
    expect(calls).toEqual([{ method: "tabs.create", props: { url: "http://127.0.0.1:4000/", active: false, windowId: 1 } }]);
    expect(calls.some((call) => call.method === "debugger.attach" || call.method === "windows.update")).toBe(false);
  });

  it("reports an asleep tab without reading or reloading it", async () => {
    const { api, calls } = apiFor(
      { 6: { id: 6, url: "http://127.0.0.1:3000/", title: "Sleeping", discarded: true, frozen: false } },
      []
    );
    const loaded = loadExtension(api);
    let result: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.read(
      api,
      { requestId: "4", chromeTabId: 6, approvedUrl: "http://127.0.0.1:3000/" },
      (_id, payload) => {
        result = payload;
      }
    );
    const read = result["read"] as { asleep: boolean; skipped: string };
    expect(read.asleep).toBe(true);
    expect(read.skipped).toBe("asleep");
    expect(calls.some((call) => call.method === "tabs.update")).toBe(false);
  });

  it("reads loopback pages when permissions.contains is false, and skips other origins", async () => {
    const scripts: { world?: string; files?: string[] }[] = [];
    const { api } = apiFor(
      {
        7: { id: 7, url: "http://127.0.0.1:3000/form", title: "Form", discarded: false, frozen: false },
        8: { id: 8, url: "https://example.com/", title: "Example", discarded: false, frozen: false },
      },
      []
    );
    (api.permissions as { contains: () => Promise<boolean> }).contains = async () => false;
    api.scripting.executeScript = async (details: { world?: string; files?: string[] }) => {
      scripts.push(details);
      return [{ result: { title: "Form", headings: [{ level: 1, text: "Soft form" }], excerpt: "Soft form", snapshot: [] } }];
    };
    const loaded = loadExtension(api);
    let local: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.read(api, { requestId: "5", chromeTabId: 7, approvedUrl: "http://127.0.0.1:3000/form" }, (_id, payload) => {
      local = payload;
    });
    const read = local["read"] as { headings: { text: string }[]; hostAccess: boolean };
    expect(read.hostAccess).toBe(true);
    expect(read.headings[0]?.text).toBe("Soft form");
    expect(scripts[0]).toMatchObject({ world: "ISOLATED", files: ["tab-page.js"] });

    scripts.length = 0;
    let remote: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.read(api, { requestId: "6", chromeTabId: 8, approvedUrl: "https://example.com/" }, (_id, payload) => {
      remote = payload;
    });
    const skipped = remote["read"] as { skipped: string; headings: unknown[] };
    expect(skipped.skipped).toMatch(/host access/);
    expect(skipped.headings).toEqual([]);
    expect(scripts).toEqual([]);
  });
});

describe("soft input in the page", () => {
  it("scrubs private details and reports a file picker as needing a real gesture", () => {
    const input = {
      tagName: "INPUT",
      type: "file",
      getAttribute: (name: string) => (name === "type" ? "file" : null),
      getBoundingClientRect: () => ({ width: 10, height: 10, left: 0, top: 0 }),
      closest: () => null,
      contains: () => false,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    };
    const loaded = loadExtension(
      {},
      {
        querySelector: () => input,
        elementFromPoint: () => input,
      }
    );
    expect(loaded.btmcpScrubText("user@example.com ghp_abcdefghijklmnopqrstuvwxyz0123456789")).not.toMatch(/user@|ghp_/);
    const result = loaded.btmcpSoftAct({ op: "click", selector: "#file" });
    expect(result).toMatchObject({ outcome: "needs a real gesture", reason: "file picker", trusted: false });
  });

  it("sets an input with the native setter and reports worked", () => {
    let stored = "";
    class HTMLInputElement {}
    const descriptor = { set: (value: string) => { stored = value; }, configurable: true };
    Object.defineProperty(HTMLInputElement.prototype, "value", descriptor);
    const input = {
      tagName: "INPUT",
      type: "text",
      disabled: false,
      readOnly: false,
      get value() { return stored; },
      set value(next: string) { stored = next; },
      getAttribute: (name: string) => (name === "type" ? "text" : null),
      getBoundingClientRect: () => ({ width: 20, height: 10, left: 0, top: 0 }),
      closest: () => null,
      contains: () => true,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    };
    const context = loadExtension(
      {},
      {
        querySelector: () => input,
        elementFromPoint: () => input,
      }
    );
    (context as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement = HTMLInputElement;
    const result = context.btmcpSoftAct({ op: "type", selector: "#name", text: "Ada" });
    expect(result).toMatchObject({ outcome: "worked", reason: null, trusted: false });
    expect(stored).toBe("Ada");
  });
});
