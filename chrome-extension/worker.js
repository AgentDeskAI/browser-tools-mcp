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

  var ws;
  try {
    ws = new WebSocket("ws://" + found.host + ":" + found.port + "/extension-ws");
  } catch (error) {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = function () {
    reconnectDelayMs = 1000;
    send({ type: "hello", extensionVersion: "2.0.0", role: "worker" });
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
