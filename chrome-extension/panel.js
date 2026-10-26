/**
 * BrowserTools MCP — panel UI.
 *
 * The devtools page hands this window a `btmcp` bridge when the panel is
 * shown. It may not exist for the first few milliseconds, hence the wait.
 */
(function () {
  "use strict";

  const el = (id) => document.getElementById(id);

  const CHECKBOXES = [
    "captureConsole",
    "captureNetwork",
    "captureResponseBodies",
    "showRequestHeaders",
    "showResponseHeaders",
  ];
  const NUMBERS = ["logLimit", "queryLimit", "stringSizeLimit"];

  const STATE_LABELS = {
    connected: "Connected",
    connecting: "Looking for the connector…",
    disconnected: "Not connected",
  };

  function renderStatus(status) {
    const state = status.state || "disconnected";
    el("dot").className = `dot ${state}`;
    el("state").textContent = STATE_LABELS[state] || state;
    el("server").textContent = status.server ? `· ${status.server}` : "";
    el("detail").textContent = status.detail || "";
  }

  function applySettings(settings) {
    el("host").value = settings.serverHost;
    el("port").value = settings.serverPort;
    el("captureMode").value = settings.captureMode;
    for (const name of CHECKBOXES) el(name).checked = Boolean(settings[name]);
    for (const name of NUMBERS) el(name).value = settings[name];
  }

  function collectSettings() {
    const next = {
      serverHost: el("host").value.trim() || "127.0.0.1",
      serverPort: Number(el("port").value) || 3025,
      captureMode: el("captureMode").value,
    };
    for (const name of CHECKBOXES) next[name] = el(name).checked;
    for (const name of NUMBERS) next[name] = Number(el(name).value) || DEFAULT_SETTINGS[name];
    return next;
  }

  async function waitForBridge(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (window.btmcp) return window.btmcp;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  async function init() {
    const bridge = await waitForBridge();
    if (!bridge) {
      el("state").textContent = "Panel could not reach the extension";
      el("detail").textContent = "Close and reopen DevTools.";
      return;
    }

    applySettings(bridge.getSettings());
    bridge.subscribe(renderStatus);

    if (bridge.getPanelInputEnabled) {
      el("allowPanelInput").checked = Boolean(await bridge.getPanelInputEnabled());
    }
    el("allowPanelInput").addEventListener("change", () => {
      if (bridge.setPanelInputEnabled) void bridge.setPanelInputEnabled(el("allowPanelInput").checked);
    });

    el("save").addEventListener("click", async () => {
      await bridge.updateSettings(collectSettings());
      el("detail").textContent = "Settings saved.";
    });

    el("reconnect").addEventListener("click", () => bridge.reconnect());

    for (const name of CHECKBOXES) {
      el(name).addEventListener("change", () => void bridge.updateSettings(collectSettings()));
    }
    el("captureMode").addEventListener("change", () =>
      void bridge.updateSettings(collectSettings())
    );

    el("cookies").addEventListener("click", async () => {
      const granted = await bridge.requestCookiePermission();
      el("detail").textContent = granted
        ? "Cookie access granted."
        : "Cookie access was declined. Storage reads will return localStorage and sessionStorage only.";
    });
  }

  document.addEventListener("DOMContentLoaded", () => void init());
})();
