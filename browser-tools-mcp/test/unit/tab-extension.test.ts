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
  context["window"] = context;
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
      snapshot: (api: unknown, message: unknown, respond: (id: string, payload: Record<string, unknown>) => void) => Promise<void>;
      soft: (api: unknown, message: unknown, respond: (id: string, payload: Record<string, unknown>) => void) => Promise<void>;
      act: (api: unknown, message: unknown, respond: (id: string, payload: Record<string, unknown>) => void) => Promise<void>;
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

type FakeNode = {
  tagName: string;
  id: string;
  children: FakeNode[];
  parent: FakeNode | null;
  attrs: Record<string, string>;
  textContent: string;
  innerText: string;
  hidden: boolean;
  style: { display?: string; visibility?: string; opacity?: string };
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  type?: string;
  labels?: FakeNode[];
  htmlFor?: string;
  focusCalls: number;
  listeners: Record<string, () => void>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { width: number; height: number; left: number; top: number };
  closest(selector: string): FakeNode | null;
  contains(other: FakeNode): boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string): void;
  dispatchEvent(event: { type: string }): void;
  focus(): void;
};

function makeNode(
  tag: string,
  options: {
    id?: string;
    text?: string;
    children?: FakeNode[];
    attrs?: Record<string, string>;
    hidden?: boolean;
    style?: FakeNode["style"];
    value?: string;
    checked?: boolean;
    type?: string;
    htmlFor?: string;
    rect?: { width: number; height: number; left: number; top: number };
  } = {}
): FakeNode {
  const node = {
    tagName: tag,
    id: options.id ?? "",
    children: options.children ?? [],
    parent: null,
    attrs: { ...(options.attrs ?? {}) },
    textContent: options.text ?? "",
    innerText: options.text ?? "",
    hidden: options.hidden === true,
    style: options.style ?? {},
    value: options.value,
    checked: options.checked,
    disabled: false,
    type: options.type,
    htmlFor: options.htmlFor,
    focusCalls: 0,
    listeners: {},
  } as FakeNode;
  node.getAttribute = (name: string) => {
    if (name === "type" && node.type) return node.type;
    return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name]! : null;
  };
  node.setAttribute = (name: string, value: string) => {
    node.attrs[name] = value;
  };
  node.hasAttribute = (name: string) => name === "hidden" && node.hidden ? true : Object.prototype.hasOwnProperty.call(node.attrs, name);
  node.getBoundingClientRect = () => options.rect ?? { width: 20, height: 10, left: 0, top: 0 };
  node.closest = (selector: string) => {
    if (selector !== "label") return null;
    let current = node.parent;
    while (current) {
      if (current.tagName === "LABEL") return current;
      current = current.parent;
    }
    return null;
  };
  node.contains = (other: FakeNode) => other === node || node.children.some((child) => child.contains(other));
  node.addEventListener = (type: string, fn: () => void) => {
    node.listeners[type] = fn;
  };
  node.removeEventListener = (type: string) => {
    delete node.listeners[type];
  };
  node.dispatchEvent = (event: { type: string }) => {
    node.listeners[event.type]?.();
  };
  node.focus = () => {
    node.focusCalls += 1;
  };
  for (const child of node.children) child.parent = node;
  return node;
}

function flatten(node: FakeNode, into: FakeNode[] = []): FakeNode[] {
  into.push(node);
  for (const child of node.children) flatten(child, into);
  return into;
}

describe("semantic page map", () => {
  function mapContext() {
    const button = makeNode("BUTTON", { id: "go", text: "Run check" });
    const hiddenChild = makeNode("BUTTON", { text: "Hidden action" });
    const hiddenWrap = makeNode("DIV", { style: { display: "none" }, children: [hiddenChild] });
    const ghost = makeNode("BUTTON", { text: "Ghost", style: { visibility: "hidden" } });
    const email = makeNode("BUTTON", { text: "user@example.com" });
    const label = makeNode("LABEL", { id: "name-label", text: "Name", htmlFor: "name" });
    const input = makeNode("INPUT", { id: "name", type: "text", value: "" });
    input.labels = [label];
    const password = makeNode("INPUT", { id: "pw", type: "password", value: "hunter2" });
    const box = makeNode("INPUT", {
      id: "agree",
      type: "checkbox",
      checked: true,
      attrs: { "aria-label": "Agree" },
    });
    const labelled = makeNode("BUTTON", { attrs: { "aria-labelledby": "name-label" }, text: "ignored" });
    const body = makeNode("BODY", {
      children: [button, hiddenWrap, ghost, email, label, input, password, box, labelled],
    });
    const nodes = flatten(body);
    const rootAttrs: Record<string, string> = {};
    const document = {
      title: "Map",
      body,
      documentElement: {
        getAttribute: (name: string) => rootAttrs[name] ?? null,
        setAttribute: (name: string, value: string) => {
          rootAttrs[name] = value;
        },
      },
      getElementById: (id: string) => nodes.find((node) => node.id === id) ?? null,
      getElementsByTagName: (tag: string) => nodes.filter((node) => node.tagName === tag.toUpperCase()),
      querySelector: (selector: string) => {
        const match = /\[data-btmcp-ref="([^"]+)"\]/.exec(selector);
        if (!match) return null;
        return nodes.find((node) => node.attrs["data-btmcp-ref"] === match[1]) ?? null;
      },
      elementFromPoint: () => null as FakeNode | null,
    };
    const loaded = loadExtension({}, document) as ReturnType<typeof loadExtension> & {
      btmcpSemanticSnapshot: () => {
        nodes: Array<{
          ref: string;
          role: string;
          name: string;
          text: string;
          visible: boolean;
          state: Record<string, unknown>;
        }>;
        truncated: boolean;
      };
      btmcpActOnRef: (command: Record<string, unknown>) => Promise<{
        outcome: string;
        reason: string | null;
        trusted: boolean;
        delta: {
          urlChanged: boolean;
          previousUrl: string;
          url: string;
          consoleErrors: string[];
          failedRequests: { url: string; status: number | null }[];
        };
      }>;
      btmcpEnsureWatch: () => void;
      BTMCP_DELTA_WAIT_MS: number;
      console: { error: (...args: unknown[]) => void };
      fetch: (input: string) => Promise<{ status: number; url: string }>;
      location: { href: string; hostname: string };
      document: typeof document;
      getComputedStyle: (element: FakeNode) => { display: string; visibility: string; opacity: string };
      HTMLInputElement: { prototype: object };
    };
    loaded.getComputedStyle = (element: FakeNode) => ({
      display: element.style.display || "block",
      visibility: element.style.visibility || "visible",
      opacity: element.style.opacity || "1",
    });
    loaded.document.elementFromPoint = () => loaded.document.querySelector("[data-btmcp-ref]") as FakeNode | null;
    const originalQuery = loaded.document.querySelector;
    loaded.document.querySelector = (selector: string) => {
      const found = originalQuery(selector);
      if (found) loaded.document.elementFromPoint = () => found;
      return found;
    };
    loaded.BTMCP_DELTA_WAIT_MS = 0;
    loaded.location.href = "http://127.0.0.1/map";
    return { loaded, button, input, nodes };
  }

  it("maps role, name, text, state, and visibility, and keeps refs stable", () => {
    const { loaded, button } = mapContext();
    const first = loaded.btmcpSemanticSnapshot();
    const again = loaded.btmcpSemanticSnapshot();
    const names = first.nodes.map((node) => `${node.role}:${node.name}:${node.visible}`);
    expect(names).toContain("button:Run check:true");
    expect(names).toContain("button:Ghost:false");
    expect(names).toContain("button:[redacted]:true");
    expect(names).toContain("textbox:Name:true");
    expect(names).toContain("checkbox:Agree:true");
    expect(JSON.stringify(first)).not.toContain("user@example.com");
    expect(JSON.stringify(first)).not.toContain("hunter2");
    expect(JSON.stringify(first)).not.toContain("Hidden action");
    const agree = first.nodes.find((node) => node.name === "Agree");
    expect(agree?.state).toMatchObject({ checked: true });
    expect(first.nodes.map((node) => node.ref)).toEqual(again.nodes.map((node) => node.ref));
    expect(button.attrs["data-btmcp-ref"]).toBe(first.nodes[0]?.ref);
    expect(button.focusCalls).toBe(0);
    expect(first.truncated).toBe(false);
  });

  it("acts on a ref with the soft gates and reports only new console and network failures", async () => {
    const { loaded, input } = mapContext();
    let stored = "";
    class HTMLInputElement {}
    Object.defineProperty(HTMLInputElement.prototype, "value", {
      configurable: true,
      set(value: string) {
        stored = value;
      },
    });
    loaded.HTMLInputElement = HTMLInputElement;
    Object.defineProperty(input, "value", {
      get: () => stored,
      set: (value: string) => {
        stored = value;
      },
    });
    const seen: string[] = [];
    loaded.console = {
      error: (...args: unknown[]) => {
        seen.push(args.map(String).join(" "));
      },
    };
    const fetches: string[] = [];
    loaded.fetch = async (url: string) => {
      fetches.push(url);
      return { status: 500, url: "http://127.0.0.1/api/fail" };
    };
    input.dispatchEvent = () => {
      loaded.console.error("before-should-not-leak");
    };
    loaded.btmcpEnsureWatch();
    loaded.console.error("already there");
    input.dispatchEvent = (event: { type: string }) => {
      if (event.type !== "input") return;
      loaded.console.error("MARKER-MAP-ERROR");
      void loaded.fetch("/api/fail");
      loaded.location.href = "http://127.0.0.1/map?changed=1";
    };

    const map = loaded.btmcpSemanticSnapshot();
    const ref = map.nodes.find((node) => node.role === "textbox" && node.name === "Name")?.ref;
    expect(ref).toMatch(/^e[1-9]/);
    const result = await loaded.btmcpActOnRef({ op: "type", ref, text: "Ada" });
    expect(result).toMatchObject({ outcome: "worked", reason: null, trusted: false });
    expect(stored).toBe("Ada");
    expect(result.delta.urlChanged).toBe(true);
    expect(result.delta.url).toBe("http://127.0.0.1/map?changed=1");
    expect(result.delta.consoleErrors).toEqual(["MARKER-MAP-ERROR"]);
    expect(result.delta.failedRequests).toEqual([{ url: "http://127.0.0.1/api/fail", status: 500 }]);
    expect(fetches).toEqual(["/api/fail"]);
    expect(seen.join(" ")).toContain("MARKER-MAP-ERROR");
    expect(input.focusCalls).toBe(0);
  });
});

describe("snapshot and act extension actions", () => {
  function apiFor(tabs: Record<number, Record<string, unknown>>) {
    const calls: { method: string; props?: unknown }[] = [];
    const scripts: { world?: string; files?: string[] }[] = [];
    const api = {
      storage: {
        session: storageArea({ btmcpPopupSwitch: true }),
        local: storageArea({ btmcpExcludeOrigins: [] }),
      },
      tabs: {
        get: async (id: number) => tabs[id],
        update: async () => {
          calls.push({ method: "tabs.update" });
        },
      },
      windows: { update: async () => calls.push({ method: "windows.update" }) },
      permissions: { contains: async () => true },
      scripting: {
        executeScript: async (details: { world?: string; files?: string[] }) => {
          scripts.push(details);
          if (details.files) return [{ result: null }];
          if (details.world === "ISOLATED") {
            return [
              {
                result: {
                  title: "Map",
                  truncated: false,
                  nodes: [{ ref: "e1", role: "button", name: "Run check", text: "Run check", state: {}, visible: true, depth: 1 }],
                },
              },
            ];
          }
          return [
            {
              result: {
                outcome: "worked",
                reason: null,
                detail: "Untrusted click was delivered to the element.",
                trusted: false,
                delta: {
                  previousUrl: "http://127.0.0.1:3000/map",
                  url: "http://127.0.0.1:3000/map?changed=1",
                  consoleErrors: ["MARKER-MAP-ERROR"],
                  failedRequests: [{ url: "http://127.0.0.1:3000/api/fail", status: 500 }],
                },
              },
            },
          ];
        },
      },
      debugger: { attach() { calls.push({ method: "debugger.attach" }); } },
    };
    return { api, calls, scripts };
  }

  it("snapshots in the isolated world and does not attach the debugger or change focus", async () => {
    const { api, calls, scripts } = apiFor({
      7: { id: 7, url: "http://127.0.0.1:3000/map", title: "Map", discarded: false, frozen: false },
    });
    const loaded = loadExtension(api);
    loaded.BTMCP_SAFETY.install(api);
    let result: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.snapshot(api, { requestId: "s", chromeTabId: 7, approvedUrl: "http://127.0.0.1:3000/map" }, (_id, payload) => {
      result = payload;
    });
    expect(result["ok"]).toBe(true);
    const snapshot = result["snapshot"] as { nodes: { ref: string }[]; hostAccess: boolean };
    expect(snapshot.hostAccess).toBe(true);
    expect(snapshot.nodes[0]?.ref).toBe("e1");
    expect(scripts[0]).toMatchObject({ world: "ISOLATED", files: ["tab-page.js"] });
    expect(calls).toEqual([]);
    expect((result["safety"] as { debuggerCalls: number; focusChanges: number }).debuggerCalls).toBe(0);
  });

  it("rejects a ref that did not come from the page map before touching the page", async () => {
    const { api, scripts } = apiFor({
      7: { id: 7, url: "http://127.0.0.1:3000/map", discarded: false, frozen: false },
    });
    const loaded = loadExtension(api);
    let result: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.act(api, { requestId: "a", chromeTabId: 7, ref: "#go", op: "click", approvedUrl: "http://127.0.0.1:3000/map" }, (_id, payload) => {
      result = payload;
    });
    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toMatch(/snapshotTab/);
    expect(scripts).toEqual([]);
  });

  it("acts in the main world and returns the what-changed delta", async () => {
    const { api, calls, scripts } = apiFor({
      7: { id: 7, url: "http://127.0.0.1:3000/map", discarded: false, frozen: false },
    });
    const loaded = loadExtension(api);
    loaded.BTMCP_SAFETY.install(api);
    let result: Record<string, unknown> = {};
    await loaded.BTMCP_TABS.act(
      api,
      { requestId: "a", chromeTabId: 7, ref: "e1", op: "click", approvedUrl: "http://127.0.0.1:3000/map" },
      (_id, payload) => {
        result = payload;
      }
    );
    expect(result["ok"]).toBe(true);
    expect(result["trusted"]).toBe(false);
    expect(result["outcome"]).toBe("worked");
    expect(result["delta"]).toMatchObject({
      urlChanged: true,
      consoleErrors: ["MARKER-MAP-ERROR"],
      failedRequests: [{ url: "http://127.0.0.1:3000/api/fail", status: 500 }],
    });
    expect(scripts.some((script) => script.world === "MAIN")).toBe(true);
    expect(calls.some((call) => call.method === "debugger.attach" || call.method === "windows.update" || call.method === "tabs.update")).toBe(false);
  });
});
