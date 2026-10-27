/**
 * Counts debugger calls and refuses focus changes.
 *
 * Wrapping chrome.debugger still calls through, so a real attach would show
 * the banner. Tab actions never call it. tabs.update({active:true}) and
 * windows.update({focused:true}) throw before the browser sees them.
 */
var BTMCP_SAFETY = (function () {
  var debuggerCalls = 0;
  var focusChanges = 0;
  var installed = false;

  function snapshot() {
    return { debuggerCalls: debuggerCalls, focusChanges: focusChanges };
  }

  function noteFocus() {
    focusChanges += 1;
  }

  function assertNoFocus(props) {
    if (!props || typeof props !== "object") return;
    if (props.active === true || props.focused === true) {
      noteFocus();
      throw new Error("Refusing to change focus.");
    }
  }

  function install(chromeApi) {
    if (installed || !chromeApi) return;
    installed = true;

    if (chromeApi.debugger) {
      ["attach", "sendCommand", "detach"].forEach(function (name) {
        var original = chromeApi.debugger[name];
        if (typeof original !== "function") return;
        chromeApi.debugger[name] = function () {
          debuggerCalls += 1;
          return original.apply(chromeApi.debugger, arguments);
        };
      });
    }

    if (chromeApi.tabs && typeof chromeApi.tabs.update === "function") {
      var update = chromeApi.tabs.update.bind(chromeApi.tabs);
      chromeApi.tabs.update = function (tabId, props) {
        assertNoFocus(props);
        return update(tabId, props);
      };
    }

    if (chromeApi.windows && typeof chromeApi.windows.update === "function") {
      var winUpdate = chromeApi.windows.update.bind(chromeApi.windows);
      chromeApi.windows.update = function (windowId, props) {
        assertNoFocus(props);
        return winUpdate(windowId, props);
      };
    }

    var root = typeof globalThis !== "undefined" ? globalThis : self;
    root.__btmcpSafety = { snapshot: snapshot };
  }

  /**
   * Navigation and new tabs must say active: false. Anything else is refused
   * and is not forwarded.
   */
  function tabsUpdate(chromeApi, tabId, props) {
    if (!props || props.active !== false || props.focused === true) {
      noteFocus();
      throw new Error("Navigation must pass active: false.");
    }
    return chromeApi.tabs.update(tabId, { url: props.url, active: false });
  }

  function tabsCreate(chromeApi, props) {
    if (!props || props.active !== false || props.focused === true) {
      noteFocus();
      throw new Error("A new tab must pass active: false.");
    }
    var create = { url: props.url, active: false };
    if (typeof props.windowId === "number") create.windowId = props.windowId;
    return chromeApi.tabs.create(create);
  }

  return {
    install: install,
    snapshot: snapshot,
    tabsUpdate: tabsUpdate,
    tabsCreate: tabsCreate,
  };
})();
