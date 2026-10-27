/**
 * BrowserTools MCP — DevTools page.
 *
 * Everything lives here rather than in a background service worker. In
 * Manifest V3 the worker is evicted aggressively, and the resulting
 * "Could not establish connection. Receiving end does not exist." was one of
 * the most common failures in 1.x. The DevTools page lives exactly as long as
 * the DevTools window, which is exactly as long as we need it.
 */
(function () {
  "use strict";

  const tabId = api.devtools.inspectedWindow.tabId;

  let settings = { ...DEFAULT_SETTINGS };
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelayMs = 1000;
  let connectionState = "disconnected";
  let serverAddress = null;
  let debuggerAttached = false;
  let injectPollTimer = null;
  let closing = false;

  const consoleQueue = [];
  const networkQueue = [];
  let flushTimer = null;

  const listeners = new Set();

  // ---------------------------------------------------------------- status

  function setState(state, detail) {
    connectionState = state;
    const message = {
      type: "status",
      state,
      detail: detail || "",
      server: serverAddress ? `${serverAddress.host}:${serverAddress.port}` : null,
      captureMode: debuggerAttached ? "debugger" : settings.captureMode,
    };
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        /* panel went away */
      }
    }
  }

  function getStatus() {
    return {
      type: "status",
      state: connectionState,
      server: serverAddress ? `${serverAddress.host}:${serverAddress.port}` : null,
      captureMode: debuggerAttached ? "debugger" : settings.captureMode,
    };
  }

  // ------------------------------------------------------------ connection

  async function connect() {
    if (closing) return;
    clearTimeout(reconnectTimer);
    setState("connecting");

    const found = await discoverServer(settings);
    if (!found) {
      setState(
        "disconnected",
        "No connector found on localhost. Start your MCP client, or run: npx @agentdeskai/browser-tools-mcp"
      );
      scheduleReconnect();
      return;
    }

    serverAddress = { host: found.host, port: found.port };

    let ws;
    try {
      ws = new WebSocket(`ws://${found.host}:${found.port}/extension-ws`);
    } catch (error) {
      setState("disconnected", String(error));
      scheduleReconnect();
      return;
    }

    socket = ws;

    ws.onopen = () => {
      reconnectDelayMs = 1000;
      setState("connected");
      send({ type: "hello", extensionVersion: "2.0.0", tabId, role: "devtools" });
      void reportPanelSwitch();
      sendPageState();
      startCapture();
      // Deliver anything captured while the connection was coming up.
      flush();
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(message);
    };

    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
      setState("disconnected", "Connection error");
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      setState("disconnected", "Connection closed");
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closing) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelayMs);
    // Back off to at most 15s so a missing server does not spin.
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function respond(requestId, payload) {
    send({ requestId, ...payload });
  }

  function handleServerMessage(message) {
    switch (message.type) {
      case "welcome":
        if (message.settings) applyServerSettings(message.settings);
        break;
      case "settings":
        if (message.settings) applyServerSettings(message.settings);
        break;
      case "ping":
        send({ type: "pong", id: message.id });
        break;
      case "capture-screenshot":
        void captureScreenshot(message);
        break;
      case "refresh-tab":
        void refreshTab(message);
        break;
      case "get-storage":
        void readStorage(message);
        break;
      default:
        break;
    }
  }

  function readPanelSwitch() {
    return new Promise((resolve) => {
      try {
        api.storage.session.get(BTMCP_GATES.PANEL_SWITCH_KEY, (stored) => {
          resolve(stored?.[BTMCP_GATES.PANEL_SWITCH_KEY] === true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  async function reportPanelSwitch() {
    send({ type: "capability-state", panelEnabled: await readPanelSwitch() });
  }

  function applyServerSettings(incoming) {
    settings = { ...settings, ...incoming };
    void saveSettings(settings);
  }

  // --------------------------------------------------------------- capture

  function queueConsole(entry) {
    if (!settings.captureConsole) return;
    consoleQueue.push(entry);
    scheduleFlush();
  }

  function queueNetwork(entry) {
    if (!settings.captureNetwork) return;
    networkQueue.push(entry);
    scheduleFlush();
  }

  const MAX_BUFFERED_ENTRIES = 1000;

  /** Batched so a chatty page does not produce one websocket frame per line. */
  function scheduleFlush(delayMs = 100) {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, delayMs);
  }

  /**
   * Sends what has been captured, keeping it buffered until there is somewhere
   * to send it. A page's first requests usually finish before the connector
   * handshake completes, and dropping them lost exactly the load-time activity
   * that matters most.
   */
  function flush() {
    flushTimer = null;
    if (!consoleQueue.length && !networkQueue.length) return;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      trimQueue(consoleQueue);
      trimQueue(networkQueue);
      scheduleFlush(500);
      return;
    }

    deliver("console", consoleQueue);
    deliver("network", networkQueue);
  }

  function deliver(type, queue) {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    if (!send({ type, entries: batch })) {
      // Put them back and try again rather than losing the batch.
      queue.unshift(...batch);
      trimQueue(queue);
      scheduleFlush(500);
    }
  }

  function trimQueue(queue) {
    if (queue.length > MAX_BUFFERED_ENTRIES) {
      queue.splice(0, queue.length - MAX_BUFFERED_ENTRIES);
    }
  }

  /**
   * Scrubs credentials, then shortens. Anything captured from the page goes
   * through here, so a secret is redacted while still intact rather than after
   * truncation has made it unrecognisable.
   */
  function truncate(value) {
    const limit = Number(settings.stringSizeLimit) || 500;
    return scrubAndTruncate(value, limit);
  }

  function startCapture() {
    if (settings.captureMode === "debugger" && api.debugger) {
      attachDebugger();
    } else {
      startInjectedCapture();
    }
  }

  function stopCapture() {
    detachDebugger();
    stopInjectedCapture();
  }

  // --- console capture via the DevTools protocol ---------------------------

  function attachDebugger() {
    if (debuggerAttached || !api.debugger) return;
    api.debugger.attach({ tabId }, "1.3", () => {
      if (api.runtime.lastError) {
        // Most often: another debugger client is already attached.
        setState(
          connectionState,
          `Console capture unavailable: ${api.runtime.lastError.message}. Switch capture mode to "inject" in the panel.`
        );
        startInjectedCapture();
        return;
      }
      debuggerAttached = true;
      api.debugger.sendCommand({ tabId }, "Runtime.enable");
      api.debugger.sendCommand({ tabId }, "Log.enable");
      api.debugger.sendCommand({ tabId }, "Page.enable");
      setState(connectionState);
    });
  }

  function detachDebugger() {
    if (!debuggerAttached || !api.debugger) return;
    debuggerAttached = false;
    try {
      api.debugger.detach({ tabId }, () => void api.runtime.lastError);
    } catch {
      /* already detached */
    }
  }

  function onDebuggerEvent(source, method, params) {
    if (!source || source.tabId !== tabId) return;

    if (method === "Runtime.consoleAPICalled") {
      queueConsole({
        type: params.type === "error" ? "console-error" : "console-log",
        level: params.type || "log",
        message: truncate((params.args || []).map(formatRemoteObject).join(" ")),
        timestamp: params.timestamp ? Math.round(params.timestamp) : Date.now(),
        url: params.stackTrace?.callFrames?.[0]?.url,
        stackTrace: summariseStack(params.stackTrace),
      });
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails || {};
      const description = details.exception?.description || details.text || "Uncaught exception";
      queueConsole({
        type: "console-error",
        level: "error",
        message: truncate(description),
        timestamp: Date.now(),
        url: details.url,
        stackTrace: summariseStack(details.stackTrace),
      });
      return;
    }

    if (method === "Log.entryAdded") {
      const entry = params.entry || {};
      queueConsole({
        type: entry.level === "error" ? "console-error" : "console-log",
        level: entry.level || "log",
        message: truncate(entry.text || ""),
        timestamp: entry.timestamp ? Math.round(entry.timestamp) : Date.now(),
        url: entry.url,
      });
    }
  }

  function formatRemoteObject(arg) {
    if (!arg) return "";
    if (arg.type === "string") return arg.value ?? "";
    if ("value" in arg && arg.value !== undefined) {
      try {
        return typeof arg.value === "object" ? JSON.stringify(arg.value) : String(arg.value);
      } catch {
        return String(arg.value);
      }
    }
    if (arg.preview) {
      const props = (arg.preview.properties || [])
        .map((prop) => `${prop.name}: ${prop.value}`)
        .join(", ");
      return `${arg.preview.description || arg.className || "Object"}{${props}}`;
    }
    return arg.description || arg.className || arg.type || "";
  }

  function summariseStack(stackTrace) {
    if (!stackTrace?.callFrames?.length) return undefined;
    return stackTrace.callFrames.slice(0, 10).map((frame) => ({
      functionName: frame.functionName || "(anonymous)",
      url: frame.url,
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
    }));
  }

  // --- console capture by wrapping the page's console ---------------------

  function startInjectedCapture() {
    if (injectPollTimer) return;
    api.devtools.inspectedWindow.eval(INJECT_BOOTSTRAP);
    injectPollTimer = setInterval(drainInjectedConsole, 500);
  }

  function stopInjectedCapture() {
    clearInterval(injectPollTimer);
    injectPollTimer = null;
  }

  function drainInjectedConsole() {
    api.devtools.inspectedWindow.eval(INJECT_DRAIN, (result, exception) => {
      if (evalFailed(exception) || !Array.isArray(result)) return;
      for (const entry of result) {
        queueConsole({
          type: entry.level === "error" ? "console-error" : "console-log",
          level: entry.level,
          message: truncate(entry.message),
          timestamp: entry.timestamp,
        });
      }
    });
  }

  // --- network capture -----------------------------------------------------

  /** The HAR entry carries the real start time; fall back to finish minus duration. */
  function startedAtOf(request) {
    var parsed = Date.parse(request && request.startedDateTime);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    var duration = Math.round((request && request.time) || 0);
    return duration > 0 ? Date.now() - duration : undefined;
  }

  function onRequestFinished(request) {
    if (!settings.captureNetwork) return;

    const req = request.request || {};
    const res = request.response || {};
    const url = req.url || "";
    if (!url || url.startsWith("chrome-extension://") || url.startsWith("moz-extension://")) return;

    const entry = {
      type: "network-request",
      url: truncate(url),
      method: req.method || "GET",
      status: res.status || 0,
      timestamp: Date.now(),
      // HAR needs the start; the finish is what we happen to be standing at.
      startedAt: startedAtOf(request),
      durationMs: Math.round(request.time || 0),
      requestHeaders: headersToObject(req.headers),
      responseHeaders: headersToObject(res.headers),
    };

    if (!settings.captureResponseBodies) {
      queueNetwork(entry);
      return;
    }

    // getContent is asynchronous and not always available; never let it hold
    // up the rest of the capture.
    let settled = false;
    const finish = (body) => {
      if (settled) return;
      settled = true;
      if (body) entry.responseBody = truncate(body);
      queueNetwork(entry);
    };

    setTimeout(() => finish(null), 2000);
    try {
      request.getContent((content) => finish(content));
    } catch {
      finish(null);
    }
  }

  function headersToObject(headers) {
    const out = {};
    for (const header of headers || []) {
      if (header && header.name) out[header.name] = truncate(String(header.value ?? ""));
    }
    return out;
  }

  // --- page state ----------------------------------------------------------

  function sendPageState() {
    api.devtools.inspectedWindow.eval("window.location.href", (url, exception) => {
      if (!evalFailed(exception) && typeof url === "string") {
        send({ type: "page", url, tabId });
      }
    });
  }

  /**
   * A generous in-page cap, well above stringSizeLimit.
   *
   * It exists to bound what crosses the extension boundary, not to redact: the
   * real scrub and truncate happen here, in that order, once the value is out
   * of the page. Cutting to the final limit in the page is what let a token be
   * sliced mid-way and stop matching.
   */
  const IN_PAGE_ELEMENT_CAP = 50_000;

  function onSelectionChanged() {
    api.devtools.inspectedWindow.eval(
      `(function () {
        var el = $0;
        if (!el) return null;
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        var rect = el.getBoundingClientRect();
        return {
          tagName: el.tagName,
          id: el.id || undefined,
          className: el.className || undefined,
          attributes: attrs,
          textContent: (el.textContent || "").slice(0, ${IN_PAGE_ELEMENT_CAP}),
          innerHTML: (el.innerHTML || "").slice(0, ${IN_PAGE_ELEMENT_CAP}),
          boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      })()`,
      (element, exception) => {
        if (evalFailed(exception) || !element) return;
        const limit = Number(settings.stringSizeLimit) || 500;
        send({ type: "selected-element", element: sanitiseSelectedElement(element, limit) });
      }
    );
  }

  // --- server-initiated requests -------------------------------------------

  /**
   * Captures through the DevTools protocol rather than tabs.captureVisibleTab.
   *
   * captureVisibleTab photographs the focused window, so with DevTools
   * undocked it captured DevTools itself and failed with
   * "Cannot access contents of url devtools://". Page.captureScreenshot
   * targets the inspected page directly and needs no window focus.
   */

  /**
   * Progressively cheaper encodings, tried in order until one fits the budget.
   *
   * A full-viewport PNG on a high-DPI display runs to tens of megabytes of
   * base64 — far more than a model's context can take, and past the read
   * buffer newer MCP stdio transports enforce, which drops the connection.
   */
  const SCREENSHOT_ATTEMPTS = [
    { format: "png" },
    { format: "jpeg", quality: 85 },
    { format: "jpeg", quality: 75, scale: 0.75 },
    { format: "jpeg", quality: 65, scale: 0.5 },
    { format: "jpeg", quality: 55, scale: 0.35 },
  ];

  function sendDebuggerCommand(method, params) {
    return new Promise((resolve, reject) => {
      api.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message));
        else resolve(result);
      });
    });
  }

  /** Viewport rectangle, used to downscale without changing the page itself. */
  async function viewportClip(scale) {
    try {
      const metrics = await sendDebuggerCommand("Page.getLayoutMetrics");
      const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport;
      if (!viewport) return null;
      const width = Math.round(viewport.clientWidth || 0);
      const height = Math.round(viewport.clientHeight || 0);
      if (!width || !height) return null;
      return { x: 0, y: 0, width, height, scale };
    } catch {
      return null;
    }
  }

  async function captureScreenshot(message) {
    if (!debuggerAttached || !api.debugger) {
      respond(message.requestId, {
        type: "screenshot-result",
        ok: false,
        error: api.debugger
          ? 'Screenshots require the "debugger" capture mode. Enable it in the BrowserTools panel and reload DevTools.'
          : "Screenshots are not available in this browser: they use the DevTools protocol, which only Chromium-based browsers expose to extensions.",
      });
      return;
    }

    const maxBytes =
      Number(message.maxBytes) || Number(settings.screenshotMaxBytes) || 3000000;
    // base64 inflates by 4/3, and the budget is expressed in decoded bytes.
    const maxBase64 = Math.floor((maxBytes * 4) / 3);

    try {
      let best = null;

      for (const attempt of SCREENSHOT_ATTEMPTS) {
        const params = { format: attempt.format, captureBeyondViewport: false };
        if (attempt.quality) params.quality = attempt.quality;
        if (attempt.scale) {
          const clip = await viewportClip(attempt.scale);
          // Without a clip there is no way to downscale, so stop degrading.
          if (!clip) break;
          params.clip = clip;
        }

        const result = await sendDebuggerCommand("Page.captureScreenshot", params);
        if (!result || !result.data) continue;

        best = { data: result.data, format: attempt.format };
        if (result.data.length <= maxBase64) break;
      }

      if (!best) {
        respond(message.requestId, {
          type: "screenshot-result",
          ok: false,
          error: "The browser returned no image data",
        });
        return;
      }

      const mimeType = best.format === "jpeg" ? "image/jpeg" : "image/png";
      respond(message.requestId, {
        type: "screenshot-result",
        ok: true,
        data: `data:${mimeType};base64,${best.data}`,
      });
    } catch (error) {
      respond(message.requestId, {
        type: "screenshot-result",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function refreshTab(message) {
    try {
      api.devtools.inspectedWindow.reload({ ignoreCache: false });
      respond(message.requestId, { type: "refresh-result", ok: true });
    } catch (error) {
      respond(message.requestId, {
        type: "refresh-result",
        ok: false,
        error: String(error),
      });
    }
  }

  async function readStorage(message) {
    const kinds = Array.isArray(message.kinds) ? message.kinds : ["localStorage", "sessionStorage"];
    const storage = {};

    try {
      if (kinds.includes("localStorage") || kinds.includes("sessionStorage")) {
        const webStorage = await evalPromise(
          `(function () {
            function dump(store) {
              var out = {};
              try {
                for (var i = 0; i < store.length; i++) {
                  var key = store.key(i);
                  out[key] = String(store.getItem(key)).slice(0, 2000);
                }
              } catch (e) { return { __error: String(e) }; }
              return out;
            }
            return { localStorage: dump(window.localStorage), sessionStorage: dump(window.sessionStorage) };
          })()`
        );
        if (kinds.includes("localStorage")) storage.localStorage = webStorage?.localStorage ?? {};
        if (kinds.includes("sessionStorage")) storage.sessionStorage = webStorage?.sessionStorage ?? {};
      }

      if (kinds.includes("cookies")) {
        storage.cookies = await readCookies();
      }

      respond(message.requestId, { type: "storage-result", ok: true, storage });
    } catch (error) {
      respond(message.requestId, {
        type: "storage-result",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Cookies need an optional permission the user grants from the panel. */
  async function readCookies() {
    if (!api.cookies) {
      return { error: "Cookie access has not been granted. Enable it in the BrowserTools panel." };
    }
    const url = await evalPromise("window.location.href");
    if (typeof url !== "string") return [];

    return new Promise((resolve) => {
      try {
        api.cookies.getAll({ url }, (cookies) => {
          if (api.runtime.lastError) {
            resolve({ error: api.runtime.lastError.message });
            return;
          }
          resolve(
            (cookies || []).map((cookie) => ({
              name: cookie.name,
              value: String(cookie.value ?? "").slice(0, 2000),
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite,
              expirationDate: cookie.expirationDate,
            }))
          );
        });
      } catch (error) {
        resolve({ error: String(error) });
      }
    });
  }

  /**
   * inspectedWindow.eval always passes a second argument; it only signals a
   * failure when isError or isException is set. Treating its mere presence as
   * an error makes every successful eval look like it failed.
   */
  function evalFailed(exception) {
    return Boolean(exception && (exception.isError || exception.isException));
  }

  function evalErrorMessage(exception) {
    if (!exception) return "eval failed";
    if (exception.value) return String(exception.value);
    const description = exception.description || "eval failed";
    const details = Array.isArray(exception.details) ? exception.details : [];
    // Chrome's descriptions are printf-style, e.g. "Operation failed: %s".
    return details.reduce(
      (text, detail) => text.replace("%s", String(detail)),
      String(description)
    );
  }

  function evalPromise(expression) {
    return new Promise((resolve, reject) => {
      api.devtools.inspectedWindow.eval(expression, (result, exception) => {
        if (evalFailed(exception)) reject(new Error(evalErrorMessage(exception)));
        else resolve(result);
      });
    });
  }

  // ------------------------------------------------------------------ wiring

  api.devtools.panels.create("BrowserTools", "", "panel.html", (panel) => {
    panel.onShown.addListener((panelWindow) => {
      panelWindow.btmcp = {
        getStatus,
        getSettings: () => ({ ...settings }),
        async updateSettings(next) {
          const previous = settings;
          settings = { ...settings, ...next };
          await saveSettings(settings);
          send({ type: "settings", settings });

          // Reconnect only when the address actually changed. The old code
          // compared the incoming value against itself after assignment, so
          // changing host or port never took effect until DevTools restarted.
          const addressChanged =
            previous.serverHost !== settings.serverHost ||
            Number(previous.serverPort) !== Number(settings.serverPort);
          const modeChanged = previous.captureMode !== settings.captureMode;

          if (modeChanged) {
            stopCapture();
            startCapture();
          }
          if (addressChanged) {
            reconnectDelayMs = 1000;
            try {
              socket?.close();
            } catch {
              /* already closed */
            }
            void connect();
          }
        },
        reconnect() {
          reconnectDelayMs = 1000;
          try {
            socket?.close();
          } catch {
            /* already closed */
          }
          void connect();
        },
        subscribe(listener) {
          listeners.add(listener);
          listener(getStatus());
          return () => listeners.delete(listener);
        },
        async getPanelInputEnabled() {
          return readPanelSwitch();
        },
        async setPanelInputEnabled(enabled) {
          const on = enabled === true;
          await new Promise((resolve) => {
            try {
              const next = {};
              next[BTMCP_GATES.PANEL_SWITCH_KEY] = on;
              api.storage.session.set(next, () => resolve());
            } catch {
              resolve();
            }
          });
          send({ type: "capability-state", panelEnabled: on });
        },
        async requestCookiePermission() {
          if (!api.permissions) return false;
          return new Promise((resolve) => {
            api.permissions.request(
              { permissions: ["cookies"], origins: ["<all_urls>"] },
              (granted) => resolve(Boolean(granted))
            );
          });
        },
      };
    });
  });

  if (api.debugger?.onEvent) api.debugger.onEvent.addListener(onDebuggerEvent);
  if (api.debugger?.onDetach) {
    api.debugger.onDetach.addListener((source) => {
      if (source?.tabId === tabId) debuggerAttached = false;
    });
  }

  api.devtools.network.onRequestFinished.addListener(onRequestFinished);
  api.devtools.network.onNavigated.addListener((url) => {
    send({ type: "page", url, tabId });
    // A navigation resets the page context, so re-inject if that is the mode.
    if (!debuggerAttached) {
      api.devtools.inspectedWindow.eval(INJECT_BOOTSTRAP);
    }
  });
  api.devtools.panels.elements.onSelectionChanged.addListener(onSelectionChanged);

  window.addEventListener("beforeunload", () => {
    closing = true;
    stopCapture();
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  });

  void (async function start() {
    settings = await loadSettings();
    await connect();
  })();
})();
