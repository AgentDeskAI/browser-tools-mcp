/**
 * BrowserTools MCP — service worker.
 *
 * Owns the toolbar-popup switch (session storage, so it resets when the
 * browser quits) and answers capability probes with a tab URL read at that
 * moment via chrome.tabs.get. It does not click, type, navigate, or attach
 * the debugger; those actions are separate work and must call
 * BTMCP_GATES.confirmBeforeAct with a fresh tab read before they run.
 */
importScripts("shared.js", "gates.js");

var socket = null;
var reconnectTimer = null;
var reconnectDelayMs = 1000;
var closing = false;

function storageGet(area, keys) {
  return new Promise(function (resolve) {
    try {
      area.get(keys, function (stored) {
        resolve(stored || {});
      });
    } catch (error) {
      resolve({});
    }
  });
}

async function readHumanState() {
  var session = await storageGet(api.storage.session, [
    BTMCP_GATES.POPUP_SWITCH_KEY,
    BTMCP_GATES.PANEL_SWITCH_KEY,
  ]);
  var local = await storageGet(api.storage.local, [BTMCP_GATES.EXCLUDE_KEY]);
  var exclude = local[BTMCP_GATES.EXCLUDE_KEY];
  return {
    popupEnabled: session[BTMCP_GATES.POPUP_SWITCH_KEY] === true,
    panelEnabled: session[BTMCP_GATES.PANEL_SWITCH_KEY] === true,
    excludeOrigins: Array.isArray(exclude) ? exclude.filter(function (entry) { return typeof entry === "string"; }) : [],
  };
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    return false;
  }
}

async function reportState() {
  var state = await readHumanState();
  send({
    type: "capability-state",
    popupEnabled: state.popupEnabled,
    excludeOrigins: state.excludeOrigins,
  });
}

function scheduleReconnect() {
  if (closing) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(function () {
    void ensureConnected();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
}

async function ensureConnected() {
  if (closing) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  var settings = await loadSettings();
  var found = await discoverServer(settings);
  if (!found) {
    scheduleReconnect();
    return;
  }

  var token = "";
  try {
    var paired = await fetch("http://" + found.host + ":" + found.port + "/.pair", { method: "POST" });
    if (paired.ok) {
      var body = await paired.json();
      if (body && typeof body.token === "string") token = body.token;
    }
  } catch (error) {
    token = "";
  }
  if (!token) {
    scheduleReconnect();
    return;
  }

  var ws;
  try {
    ws = new WebSocket("ws://" + found.host + ":" + found.port + "/extension-ws", ["browser-tools", token]);
  } catch (error) {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = function () {
    reconnectDelayMs = 1000;
    send({ type: "hello", extensionVersion: "2.0.4", role: "worker" });
    void reportState();
  };

  ws.onmessage = function (event) {
    var message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (message && message.type === "capability-probe") {
      void answerProbe(message);
    } else if (message && message.type === "navigate-tab") {
      void navigateTab(message);
    } else if (message && message.type === "ping") {
      send({ type: "pong", id: message.id });
    }
  };

  ws.onclose = function () {
    if (socket === ws) socket = null;
    scheduleReconnect();
  };

  ws.onerror = function () {
    /* onclose follows */
  };
}

/**
 * Reads the switch and the tab again. The URL on the probe message is ignored;
 * chrome.tabs.get is the only source.
 */
function respond(requestId, payload) {
  send(Object.assign({ requestId: requestId }, payload));
}

function waitForTabUrl(tabId, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      api.tabs
        .get(tabId)
        .then(function (tab) {
          resolve(tab && tab.url ? tab.url : "");
        })
        .catch(function () {
          resolve("");
        });
    }, timeoutMs);

    function onUpdated(updatedId, changeInfo, tab) {
      if (done) return;
      if (String(updatedId) !== String(tabId)) return;
      if (changeInfo.status === "complete" && tab && tab.url) {
        done = true;
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab.url);
      }
    }
    api.tabs.onUpdated.addListener(onUpdated);
  });
}

async function navigateTab(message) {
  var tabId = message.tabId;
  var url = message.url;
  if ((typeof tabId !== "number" && typeof tabId !== "string") || typeof url !== "string" || !url) {
    respond(message.requestId, {
      type: "navigate-result",
      ok: false,
      error: "tabId and url are required",
    });
    return;
  }

  try {
    var before = await api.tabs.get(tabId);
    var wasDiscarded = Boolean(before && before.discarded);
    await api.tabs.update(tabId, { url: url, active: false });
    var finalUrl = await waitForTabUrl(tabId, 30000);
    if (!finalUrl) {
      var after = await api.tabs.get(tabId);
      finalUrl = after && after.url ? after.url : url;
    }
    respond(message.requestId, {
      type: "navigate-result",
      ok: true,
      finalUrl: finalUrl,
      wasDiscarded: wasDiscarded,
    });
  } catch (error) {
    respond(message.requestId, {
      type: "navigate-result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function answerProbe(message) {
  var state = await readHumanState();
  var liveUrl = null;

  if (message.tabId != null && (state.popupEnabled || state.panelEnabled)) {
    var tabId = typeof message.tabId === "number" ? message.tabId : Number(message.tabId);
    if (!Number.isInteger(tabId)) {
      send({
        type: "capability-probe-result",
        requestId: message.requestId,
        ok: false,
        error: "Could not read the tab",
        popupEnabled: state.popupEnabled,
        panelEnabled: state.panelEnabled,
        excludeOrigins: state.excludeOrigins,
      });
      return;
    }
    try {
      var tab = await api.tabs.get(tabId);
      liveUrl = tab && typeof tab.url === "string" ? tab.url : null;
    } catch (error) {
      send({
        type: "capability-probe-result",
        requestId: message.requestId,
        ok: false,
        error: "Could not read the tab",
        popupEnabled: state.popupEnabled,
        panelEnabled: state.panelEnabled,
        excludeOrigins: state.excludeOrigins,
      });
      return;
    }
  }

  send({
    type: "capability-probe-result",
    requestId: message.requestId,
    ok: true,
    liveUrl: liveUrl,
    popupEnabled: state.popupEnabled,
    panelEnabled: state.panelEnabled,
    excludeOrigins: state.excludeOrigins,
  });
}

if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener(function (changes, area) {
    var watched =
      (area === "session" &&
        (changes[BTMCP_GATES.POPUP_SWITCH_KEY] || changes[BTMCP_GATES.PANEL_SWITCH_KEY])) ||
      (area === "local" && changes[BTMCP_GATES.EXCLUDE_KEY]);
    if (!watched) return;
    void ensureConnected().then(reportState);
  });
}

if (api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== "capability-report") return;
    void ensureConnected().then(reportState).then(function () {
      sendResponse({ ok: true });
    });
    return true;
  });
}

if (api.alarms) {
  try {
    api.alarms.create("btmcp-capability", { periodInMinutes: 1 });
    api.alarms.onAlarm.addListener(function (alarm) {
      if (alarm && alarm.name === "btmcp-capability") void ensureConnected();
    });
  } catch (error) {
    /* alarms are a reconnect aid; the gate stays off without them */
  }
}

void ensureConnected();
