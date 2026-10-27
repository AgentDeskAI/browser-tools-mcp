/**
 * Opt-in 8-hour log for one tab or one origin.
 *
 * Off until the user checks it in the popup. Capture wraps the page's console
 * and fetch/XHR. It does not attach a debugger, so the debugging banner is
 * neither shown nor hidden by this log, and it does not click, type, or drive
 * the page.
 *
 * Cookie and Authorization are removed before an event is queued. The
 * connector removes them again before writing the log.
 */
var BTMCP_TIMELINE = (function () {
  var STORAGE_KEY = "btmcpTimeline";
  var CREDENTIAL = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;

  function emptyState() {
    return { tabs: {}, origins: {} };
  }

  function normalizeState(raw) {
    var state = emptyState();
    if (!raw || typeof raw !== "object") return state;
    var tabs = raw.tabs;
    if (tabs && typeof tabs === "object") {
      for (var id in tabs) {
        if (!Object.prototype.hasOwnProperty.call(tabs, id)) continue;
        if (!/^\d+$/.test(id)) continue;
        var tab = tabs[id];
        if (!tab || typeof tab !== "object") continue;
        state.tabs[id] = {
          origin: typeof tab.origin === "string" ? tab.origin : "",
          url: typeof tab.url === "string" ? tab.url : "",
          title: typeof tab.title === "string" ? tab.title : "",
          enabledAt: typeof tab.enabledAt === "number" ? tab.enabledAt : 0,
        };
      }
    }
    var origins = raw.origins;
    if (origins && typeof origins === "object") {
      for (var origin in origins) {
        if (!Object.prototype.hasOwnProperty.call(origins, origin)) continue;
        if (!BTMCP_GATES.originOf(origin) || BTMCP_GATES.originOf(origin) !== origin) continue;
        var entry = origins[origin];
        state.origins[origin] = {
          enabledAt: entry && typeof entry.enabledAt === "number" ? entry.enabledAt : 0,
        };
      }
    }
    return state;
  }

  function isTracked(tab, state) {
    if (!tab || typeof tab.id !== "number" || !state) return false;
    if (state.tabs && state.tabs[String(tab.id)]) return true;
    var origin = BTMCP_GATES.originOf(tab.url || "");
    return Boolean(origin && state.origins && state.origins[origin]);
  }

  function targetsFromState(state) {
    var out = [];
    var tabs = (state && state.tabs) || {};
    for (var id in tabs) {
      if (!Object.prototype.hasOwnProperty.call(tabs, id)) continue;
      var tab = tabs[id];
      out.push({
        kind: "tab",
        chromeTabId: Number(id),
        origin: tab.origin || "",
        url: tab.url || "",
        title: tab.title || "",
        enabledAt: tab.enabledAt || Date.now(),
      });
    }
    var origins = (state && state.origins) || {};
    for (var origin in origins) {
      if (!Object.prototype.hasOwnProperty.call(origins, origin)) continue;
      out.push({
        kind: "origin",
        origin: origin,
        enabledAt: origins[origin].enabledAt || Date.now(),
      });
    }
    return out;
  }

  function stripCredentialHeaders(headers) {
    var out = {};
    if (!headers || typeof headers !== "object") return out;
    for (var name in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, name)) continue;
      if (CREDENTIAL.test(name)) continue;
      var value = headers[name];
      if (typeof value === "string") out[name] = value;
    }
    return out;
  }

  /**
   * Attributes the event to the real tab, not to anything the page wrote,
   * and scrubs it before it leaves the browser.
   */
  function prepareEvent(entry, tab) {
    if (!entry || !tab || typeof tab.id !== "number") return null;
    var origin = BTMCP_GATES.originOf(tab.url || "");
    if (!origin) return null;
    var kind = entry.kind === "network" ? "network" : entry.kind === "console" ? "console" : null;
    if (!kind) return null;
    var pageUrl = typeof tab.url === "string" ? tab.url : "";
    var base = {
      kind: kind,
      chromeTabId: tab.id,
      origin: origin,
      url: kind === "network" && typeof entry.url === "string" && entry.url ? entry.url : pageUrl,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
    };
    base.url = scrubAndTruncate(base.url, 2000);
    if (kind === "console") {
      base.level = typeof entry.level === "string" ? entry.level : "log";
      base.message = scrubAndTruncate(typeof entry.message === "string" ? entry.message : "", 2000);
      return base;
    }
    base.method = typeof entry.method === "string" ? entry.method : "GET";
    base.status = typeof entry.status === "number" ? entry.status : 0;
    if (typeof entry.startedAt === "number") base.startedAt = entry.startedAt;
    if (typeof entry.durationMs === "number") base.durationMs = entry.durationMs;
    if (typeof entry.error === "string" && entry.error) base.error = scrubAndTruncate(entry.error, 500);
    var headers = stripCredentialHeaders(entry.requestHeaders);
    var scrubbed = {};
    for (var name in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, name)) continue;
      scrubbed[name] = scrubAndTruncate(headers[name], 500);
    }
    if (Object.keys(scrubbed).length) base.requestHeaders = scrubbed;
    if (typeof entry.requestBody === "string" && entry.requestBody) {
      base.requestBody = scrubAndTruncate(entry.requestBody, 2000);
    }
    return base;
  }

  /**
   * Runs in the page. Self-contained: the scripting call serializes this
   * function alone. Hooks console and fetch/XHR, drops Cookie and
   * Authorization, and posts the rest to the extension bridge. No clicks.
   */
  function installCapture() {
    var root = globalThis;
    if (root.__btmcpTimelineInstalled) return;
    root.__btmcpTimelineInstalled = true;
    var banned = { authorization: 1, "proxy-authorization": 1, cookie: 1, "set-cookie": 1 };

    function emit(entry) {
      try {
        root.postMessage({ source: "btmcp-timeline", entry: entry }, "*");
      } catch (error) {
        /* never break the page */
      }
    }

    function headerMap(input) {
      var out = {};
      if (!input) return out;
      function keep(name, value) {
        if (!name || banned[String(name).toLowerCase()]) return;
        out[String(name)] = typeof value === "string" ? value : String(value);
      }
      try {
        if (typeof input.forEach === "function") {
          input.forEach(function (value, name) {
            keep(name, value);
          });
          return out;
        }
      } catch (error) {
        /* fall through to a plain object */
      }
      if (typeof input === "object") {
        for (var key in input) {
          if (Object.prototype.hasOwnProperty.call(input, key)) keep(key, input[key]);
        }
      }
      return out;
    }

    var levels = ["log", "info", "warn", "error", "debug"];
    levels.forEach(function (level) {
      if (!root.console || typeof root.console[level] !== "function") return;
      var original = root.console[level];
      root.console[level] = function () {
        try {
          var parts = Array.prototype.map.call(arguments, function (arg) {
            if (typeof arg === "string") return arg;
            try {
              return JSON.stringify(arg);
            } catch (error) {
              return String(arg);
            }
          });
          emit({
            kind: "console",
            level: level,
            message: parts.join(" ").slice(0, 4000),
            timestamp: Date.now(),
          });
        } catch (error) {
          /* never break the page */
        }
        return original.apply(root.console, arguments);
      };
    });

    root.addEventListener("error", function (event) {
      emit({
        kind: "console",
        level: "error",
        message: String((event && event.message) || "error").slice(0, 4000),
        timestamp: Date.now(),
      });
    });
    root.addEventListener("unhandledrejection", function (event) {
      emit({
        kind: "console",
        level: "error",
        message: ("Unhandled promise rejection: " + String(event && event.reason)).slice(0, 4000),
        timestamp: Date.now(),
      });
    });

    if (typeof root.fetch === "function") {
      var origFetch = root.fetch;
      root.fetch = function (input, init) {
        var method = "GET";
        var url = "";
        var body = "";
        try {
          if (typeof input === "string") url = input;
          else if (input && typeof input.url === "string") {
            url = input.url;
            if (input.method) method = String(input.method);
          }
          if (init && init.method) method = String(init.method);
          if (init && typeof init.body === "string") body = init.body.slice(0, 4000);
        } catch (error) {
          /* keep the call */
        }
        var headers = {};
        try {
          headers = headerMap((init && init.headers) || (input && input.headers));
        } catch (error) {
          headers = {};
        }
        var started = Date.now();
        return origFetch.apply(root, arguments).then(
          function (response) {
            emit({
              kind: "network",
              method: method,
              url: url,
              status: response && typeof response.status === "number" ? response.status : 0,
              timestamp: Date.now(),
              startedAt: started,
              durationMs: Date.now() - started,
              requestHeaders: headers,
              requestBody: body,
            });
            return response;
          },
          function (error) {
            emit({
              kind: "network",
              method: method,
              url: url,
              status: 0,
              timestamp: Date.now(),
              startedAt: started,
              durationMs: Date.now() - started,
              error: String(error && error.message ? error.message : error),
              requestHeaders: headers,
              requestBody: body,
            });
            throw error;
          }
        );
      };
    }

    var XHR = root.XMLHttpRequest;
    if (typeof XHR === "function" && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      var origSet = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function (method, url) {
        this.__btmcpTimeline = {
          method: String(method || "GET"),
          url: String(url || ""),
          headers: {},
        };
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (this.__btmcpTimeline && name && !banned[String(name).toLowerCase()]) {
            this.__btmcpTimeline.headers[String(name)] = String(value);
          }
        } catch (error) {
          /* still send the header to the page's request */
        }
        return origSet.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        var self = this;
        var started = Date.now();
        var meta = this.__btmcpTimeline || { method: "GET", url: "", headers: {} };
        var requestBody = typeof body === "string" ? body.slice(0, 4000) : "";
        this.addEventListener("loadend", function () {
          emit({
            kind: "network",
            method: meta.method,
            url: meta.url,
            status: typeof self.status === "number" ? self.status : 0,
            timestamp: Date.now(),
            startedAt: started,
            durationMs: Date.now() - started,
            requestHeaders: meta.headers,
            requestBody: requestBody,
          });
        });
        return origSend.apply(this, arguments);
      };
    }
  }

  /**
   * Runs in the extension's isolated world for one opted-in tab. Forwards
   * page events to the worker. Does not read the page's JavaScript state.
   */
  function installBridge() {
    var root = globalThis;
    if (root.__btmcpTimelineBridge) return;
    root.__btmcpTimelineBridge = true;
    root.addEventListener("message", function (event) {
      var data = event && event.data;
      if (!data || data.source !== "btmcp-timeline" || !data.entry) return;
      var pageOrigin = "";
      try {
        pageOrigin = root.location && root.location.origin ? root.location.origin : "";
      } catch (error) {
        pageOrigin = "";
      }
      if (pageOrigin && event.origin && event.origin !== pageOrigin && event.origin !== "null") return;
      var runtime = (root.chrome && root.chrome.runtime) || (root.browser && root.browser.runtime);
      if (!runtime || typeof runtime.sendMessage !== "function") return;
      try {
        runtime.sendMessage({ type: "timeline-capture", entry: data.entry });
      } catch (error) {
        /* the worker may be restarting */
      }
    });
  }

  /**
   * Hooks one opted-in tab. The worker calls this; the worker file itself
   * does not name the scripting API. Failures (missing host access, a page
   * that cannot be scripted) leave the opt-in in place and capture nothing.
   */
  async function inject(chromeApi, tabId) {
    if (!chromeApi || !chromeApi.scripting || typeof chromeApi.scripting.executeScript !== "function") {
      return false;
    }
    try {
      await chromeApi.scripting.executeScript({
        target: { tabId: tabId },
        world: "ISOLATED",
        func: installBridge,
      });
      await chromeApi.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN",
        func: installCapture,
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    emptyState: emptyState,
    normalizeState: normalizeState,
    isTracked: isTracked,
    targetsFromState: targetsFromState,
    stripCredentialHeaders: stripCredentialHeaders,
    prepareEvent: prepareEvent,
    installCapture: installCapture,
    installBridge: installBridge,
    inject: inject,
  };
})();
