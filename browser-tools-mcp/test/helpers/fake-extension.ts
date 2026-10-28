import WebSocket from "ws";
import { EXAMPLE_CHROME_EXTENSION_ORIGIN } from "../../src/connector/security";

/** A 1x1 transparent PNG, used wherever a test needs real image bytes. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export interface FakeExtensionOptions {
  port: number;
  /** Reported in `hello`, so the connector can tell tabs apart. */
  tabId?: number | string;
  origin?: string;
  token?: string;
  /** Respond to capture-screenshot requests. Defaults to returning TINY_PNG_BASE64. */
  onScreenshot?: (msg: any) => Promise<unknown> | unknown;
  onRefresh?: (msg: any) => Promise<unknown> | unknown;
  onNavigate?: (msg: any) => Promise<unknown> | unknown;
  onListChromeTabs?: (msg: any) => Promise<unknown> | unknown;
  onReadChromeTab?: (msg: any) => Promise<unknown> | unknown;
  onNavigateChromeTab?: (msg: any) => Promise<unknown> | unknown;
  onSoftInput?: (msg: any) => Promise<unknown> | unknown;
  onSnapshotChromeTab?: (msg: any) => Promise<unknown> | unknown;
  onActChromeTab?: (msg: any) => Promise<unknown> | unknown;
  onStorage?: (msg: any) => Promise<unknown> | unknown;
  /** `worker` answers capability probes and is not a DevTools tab. */
  role?: "devtools" | "worker";
  onCapabilityProbe?: (msg: any) => Promise<unknown> | unknown;
}

/**
 * Stands in for the Chrome extension: connects to the connector's websocket,
 * answers the request/response messages, and records what it received.
 */
export class FakeExtension {
  readonly received: any[] = [];
  #ws: WebSocket | null = null;
  #options: FakeExtensionOptions;

  constructor(options: FakeExtensionOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    try {
      await this.#connectOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out|ECONNRESET|ECONNREFUSED|socket hang up/i.test(message)) throw error;
      this.#ws?.terminate();
      this.#ws = null;
      await this.#connectOnce();
    }
  }

  async #connectOnce(): Promise<void> {
    const { port, origin = EXAMPLE_CHROME_EXTENSION_ORIGIN, token: given } = this.#options;
    let token = given;
    if (!token) {
      const paired = await fetch(`http://127.0.0.1:${port}/.pair`, {
        method: "POST",
        headers: { Origin: origin },
        signal: AbortSignal.timeout(3_000),
      });
      if (!paired.ok) {
        throw new Error(`Extension pairing failed (${paired.status})`);
      }
      const body = (await paired.json()) as { token?: string };
      if (!body.token) throw new Error("Extension pairing returned no token");
      token = body.token;
    }

    const url = `ws://127.0.0.1:${port}/extension-ws`;
    const ws = new WebSocket(url, {
      origin,
      headers: { Authorization: `Bearer ${token}` },
    });
    this.#ws = ws;

    // Attached before 'open' resolves: the server sends its welcome frame as
    // soon as the connection is up, and a listener added afterwards misses it.
    ws.on("message", (raw) => void this.#handle(raw));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Timed out opening the extension socket"));
      }, 3_000);
      const onError = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      ws.once("error", onError);
      ws.once("open", () => {
        clearTimeout(timer);
        ws.off("error", onError);
        resolve();
      });
    });

    const role = this.#options.role;
    this.send({
      type: "hello",
      extensionVersion: "test",
      ...(role ? { role } : {}),
      ...(role === "worker" ? {} : { tabId: this.#options.tabId ?? 1 }),
    });
  }

  async #handle(raw: WebSocket.RawData): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    this.received.push(msg);

    switch (msg.type) {
      case "ping":
        this.send({ type: "pong", id: msg.id });
        break;
      case "capture-screenshot": {
        const custom = this.#options.onScreenshot;
        const payload = custom
          ? await custom(msg)
          : { ok: true, data: `data:image/png;base64,${TINY_PNG_BASE64}` };
        this.send({ type: "screenshot-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "refresh-tab": {
        const custom = this.#options.onRefresh;
        const payload = custom ? await custom(msg) : { ok: true };
        this.send({ type: "refresh-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "navigate-tab": {
        const custom = this.#options.onNavigate;
        const payload = custom
          ? await custom(msg)
          : { ok: true, finalUrl: msg.url, wasDiscarded: false, safety: { debuggerCalls: 0, focusChanges: 0 } };
        this.send({ type: "navigate-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "list-chrome-tabs": {
        const custom = this.#options.onListChromeTabs;
        const payload = custom
          ? await custom(msg)
          : { ok: true, visibleWindowId: 1, windows: [], safety: { debuggerCalls: 0, focusChanges: 0 } };
        this.send({ type: "chrome-tabs-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "read-chrome-tab": {
        const custom = this.#options.onReadChromeTab;
        const payload = custom
          ? await custom(msg)
          : {
              ok: true,
              safety: { debuggerCalls: 0, focusChanges: 0 },
              read: {
                url: "http://127.0.0.1/",
                title: "",
                asleep: false,
                frozen: false,
                skipped: null,
                headings: [],
                excerpt: "",
                snapshot: [],
                hostAccess: true,
              },
            };
        this.send({ type: "chrome-tab-read-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "navigate-chrome-tab": {
        const custom = this.#options.onNavigateChromeTab;
        const payload = custom
          ? await custom(msg)
          : {
              ok: true,
              chromeTabId: msg.chromeTabId ?? 1,
              finalUrl: msg.url,
              wasDiscarded: false,
              created: msg.create === true,
              visibleWindowId: 1,
              openedTabs: [],
              safety: { debuggerCalls: 0, focusChanges: 0 },
            };
        this.send({ type: "navigate-chrome-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "soft-input": {
        const custom = this.#options.onSoftInput;
        const payload = custom
          ? await custom(msg)
          : {
              ok: true,
              chromeTabId: msg.chromeTabId,
              outcome: "worked",
              reason: null,
              detail: "ok",
              trusted: false,
              safety: { debuggerCalls: 0, focusChanges: 0 },
            };
        this.send({ type: "soft-input-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "snapshot-chrome-tab": {
        const custom = this.#options.onSnapshotChromeTab;
        const payload = custom
          ? await custom(msg)
          : {
              ok: true,
              safety: { debuggerCalls: 0, focusChanges: 0 },
              snapshot: {
                url: "http://127.0.0.1/",
                title: "",
                asleep: false,
                frozen: false,
                skipped: null,
                hostAccess: true,
                truncated: false,
                nodes: [],
              },
            };
        this.send({ type: "chrome-tab-snapshot-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "act-chrome-tab": {
        const custom = this.#options.onActChromeTab;
        const payload = custom
          ? await custom(msg)
          : {
              ok: true,
              chromeTabId: msg.chromeTabId,
              ref: msg.ref,
              outcome: "worked",
              reason: null,
              detail: "ok",
              trusted: false,
              delta: {
                urlChanged: false,
                previousUrl: "http://127.0.0.1/",
                url: "http://127.0.0.1/",
                consoleErrors: [],
                failedRequests: [],
              },
              safety: { debuggerCalls: 0, focusChanges: 0 },
            };
        this.send({ type: "act-ref-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "get-storage": {
        const custom = this.#options.onStorage;
        const payload = custom
          ? await custom(msg)
          : { ok: true, storage: { localStorage: {}, sessionStorage: {}, cookies: [] } };
        this.send({ type: "storage-result", requestId: msg.requestId, ...(payload as object) });
        break;
      }
      case "capability-probe": {
        const custom = this.#options.onCapabilityProbe;
        if (!custom) break;
        const payload = await custom(msg);
        this.send({
          type: "capability-probe-result",
          requestId: msg.requestId,
          ok: true,
          ...(payload as object),
        });
        break;
      }
      default:
        break;
    }
  }

  send(message: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }

  /** Waits until the connector has acknowledged this extension. */
  async waitForWelcome(timeoutMs = 5_000): Promise<void> {
    await this.waitFor((m) => m.type === "welcome", timeoutMs);
  }

  async waitFor(predicate: (msg: any) => boolean, timeoutMs = 5_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Timed out waiting for message");
  }

  /**
   * Drops and re-establishes the socket as the *same* devtools page, which is
   * what a heartbeat timeout looks like on a backgrounded tab.
   */
  async reconnect(): Promise<void> {
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.terminate();
        setTimeout(resolve, 300);
      });
    }
    await this.connect();
  }

  /** Abrupt teardown, without a close handshake. */
  terminate(): void {
    try {
      this.#ws?.terminate();
    } catch {
      /* already gone */
    }
    this.#ws = null;
  }

  async close(): Promise<void> {
    const ws = this.#ws;
    if (!ws) return;
    this.#ws = null;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
      setTimeout(resolve, 500);
    });
  }
}

/** Attempts a websocket connection and resolves with whether it was accepted. */
export async function tryWebSocket(
  url: string,
  options: WebSocket.ClientOptions & { protocols?: string | string[] } = {}
): Promise<{ accepted: boolean; statusCode?: number }> {
  const { protocols, ...rest } = options;
  return new Promise((resolve) => {
    const ws = protocols ? new WebSocket(url, protocols, rest) : new WebSocket(url, rest);
    const done = (result: { accepted: boolean; statusCode?: number }) => {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    ws.once("open", () => done({ accepted: true }));
    ws.once("unexpected-response", (_req, res) =>
      done({ accepted: false, statusCode: res.statusCode })
    );
    ws.once("error", () => done({ accepted: false }));
    setTimeout(() => done({ accepted: false }), 4_000);
  });
}
