/**
 * Extension half of the capability gate.
 *
 * The connector decides process flags and the origin allowlist. This checks
 * the human switches and that the tab's URL, read immediately before acting,
 * is still the URL that was approved. Switches default off.
 */
var BTMCP_GATES = (function () {
  var POPUP_SWITCH_KEY = "btmcpPopupSwitch";
  var PANEL_SWITCH_KEY = "btmcpPanelInput";
  var EXCLUDE_KEY = "btmcpExcludeOrigins";

  var NO_DEVTOOLS_ACTIONS = ["listTabs", "readTab", "navigate", "softClick", "softType"];
  var PANEL_ACTIONS = ["click", "type", "pressKey", "evaluateScript", "debuggerFallback"];

  function includes(list, value) {
    return list.indexOf(value) !== -1;
  }

  function originOf(url) {
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (parsed.username || parsed.password) return null;
      var port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return parsed.protocol + "//" + parsed.hostname.toLowerCase() + ":" + port;
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {{
   *   action: string,
   *   popupEnabled: boolean,
   *   panelEnabled: boolean,
   *   approvedUrl?: string | null,
   *   liveUrl?: string | null,
   *   hideBanner?: boolean
   * }} input
   */
  function confirmBeforeAct(input) {
    if (input.hideBanner === true) {
      return { allowed: false, reason: "banner bypass is disabled" };
    }
    if (includes(NO_DEVTOOLS_ACTIONS, input.action) && input.popupEnabled !== true) {
      return { allowed: false, reason: "popup switch is off" };
    }
    if (includes(PANEL_ACTIONS, input.action) && input.panelEnabled !== true) {
      return { allowed: false, reason: "panel switch is off" };
    }
    if (input.action === "listTabs") {
      return { allowed: true, reason: "allowed" };
    }
    if (input.action === "navigate" && input.creatingTab === true) {
      return { allowed: true, reason: "allowed" };
    }
    var liveOrigin = originOf(input.liveUrl);
    var approvedOrigin = originOf(input.approvedUrl);
    if (!liveOrigin || !approvedOrigin) {
      return { allowed: false, reason: "tab URL is missing" };
    }
    if (liveOrigin !== approvedOrigin) {
      return { allowed: false, reason: "tab URL changed" };
    }
    return { allowed: true, reason: "allowed" };
  }

  return {
    POPUP_SWITCH_KEY: POPUP_SWITCH_KEY,
    PANEL_SWITCH_KEY: PANEL_SWITCH_KEY,
    EXCLUDE_KEY: EXCLUDE_KEY,
    NO_DEVTOOLS_ACTIONS: NO_DEVTOOLS_ACTIONS,
    PANEL_ACTIONS: PANEL_ACTIONS,
    originOf: originOf,
    confirmBeforeAct: confirmBeforeAct,
  };
})();
