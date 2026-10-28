/**
 * chrome.tabs actions for the service worker.
 *
 * List, read, semantic snapshot, background navigate, and soft click/type.
 * No debugger API. Navigation always passes active: false and never focuses
 * a window. Background navigate stays in the visible window. Acting on a
 * snapshot ref uses the same soft click and type gates.
 */
var BTMCP_TABS = (function () {
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

  async function readHumanState(chromeApi) {
    var session = await storageGet(chromeApi.storage.session, [BTMCP_GATES.POPUP_SWITCH_KEY]);
    var local = await storageGet(chromeApi.storage.local, [BTMCP_GATES.EXCLUDE_KEY]);
    var exclude = local[BTMCP_GATES.EXCLUDE_KEY];
    return {
      popupEnabled: session[BTMCP_GATES.POPUP_SWITCH_KEY] === true,
      excludeOrigins: Array.isArray(exclude)
        ? exclude.filter(function (entry) {
            return typeof entry === "string";
          })
        : [],
    };
  }

  function excluded(url, list) {
    var origin = BTMCP_GATES.originOf(url);
    if (!origin) return false;
    for (var i = 0; i < list.length; i++) {
      if (BTMCP_GATES.originOf(list[i]) === origin) return true;
    }
    return false;
  }

  function fail(respond, requestId, type, error) {
    respond(requestId, { type: type, ok: false, error: error instanceof Error ? error.message : String(error) });
  }

  function delta(before) {
    var after = BTMCP_SAFETY.snapshot();
    return {
      debuggerCalls: after.debuggerCalls - before.debuggerCalls,
      focusChanges: after.focusChanges - before.focusChanges,
    };
  }

  function serializeTab(tab, windowId) {
    return {
      chromeTabId: tab.id,
      windowId: typeof tab.windowId === "number" ? tab.windowId : windowId,
      title: typeof tab.title === "string" ? tab.title : "",
      url: typeof tab.url === "string" ? tab.url : "",
      active: tab.active === true,
      pinned: tab.pinned === true,
      discarded: tab.discarded === true,
      frozen: tab.frozen === true,
      lastAccessed: typeof tab.lastAccessed === "number" ? tab.lastAccessed : null,
      audible: tab.audible === true,
      status: typeof tab.status === "string" ? tab.status : "",
      index: typeof tab.index === "number" ? tab.index : 0,
      incognito: tab.incognito === true,
    };
  }

  async function visibleWindowId(chromeApi, already) {
    var windows = already || (await chromeApi.windows.getAll({ populate: false }));
    var i;
    for (i = 0; i < windows.length; i++) {
      var win = windows[i];
      if (win && win.focused === true && win.incognito !== true && (win.type === "normal" || !win.type)) {
        return win.id;
      }
    }
    try {
      var last = await chromeApi.windows.getLastFocused({ windowTypes: ["normal"] });
      if (last && last.incognito !== true && typeof last.id === "number") return last.id;
    } catch (error) {
      /* fall through to the first normal window */
    }
    for (i = 0; i < windows.length; i++) {
      if (windows[i] && windows[i].incognito !== true && windows[i].type === "normal") return windows[i].id;
    }
    return null;
  }

  function unsupportedPage(url) {
    if (!url) return "missing url";
    var lower = url.toLowerCase();
    if (
      lower.indexOf("chrome://") === 0 ||
      lower.indexOf("chrome-extension://") === 0 ||
      lower.indexOf("edge://") === 0 ||
      lower.indexOf("about:") === 0 ||
      lower.indexOf("devtools://") === 0
    ) {
      return "unsupported page";
    }
    if (lower.indexOf("https://chrome.google.com/webstore") === 0 || lower.indexOf("https://chromewebstore.google.com") === 0) {
      return "web store";
    }
    if (/\.pdf($|\?)/i.test(lower)) return "pdf viewer";
    if (!/^https?:\/\//i.test(url)) return "unsupported page";
    return null;
  }

  /**
   * chrome.permissions.contains only reports optional grants. The manifest
   * already allows http loopback, and that must count as granted.
   */
  function manifestCovers(url) {
    try {
      var parsed = new URL(url);
      return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    } catch (error) {
      return false;
    }
  }

  async function hostGranted(chromeApi, url) {
    if (manifestCovers(url)) return true;
    try {
      var parsed = new URL(url);
      var candidates = ["<all_urls>", parsed.origin + "/*"];
      if (parsed.port) candidates.push(parsed.protocol + "//" + parsed.hostname + "/*");
      for (var i = 0; i < candidates.length; i++) {
        var granted = await chromeApi.permissions.contains({ origins: [candidates[i]] });
        if (granted) return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * executeScript serializes `func` alone. Helpers live in tab-page.js, so
   * that file is injected into the same world before the call.
   */
  async function runInTab(chromeApi, tabId, world, entry, args) {
    await chromeApi.scripting.executeScript({
      target: { tabId: tabId },
      world: world,
      files: ["tab-page.js"],
    });
    var details = {
      target: { tabId: tabId },
      world: world,
      func: entry,
    };
    if (args) details.args = args;
    return chromeApi.scripting.executeScript(details);
  }

  function readPageEntry() {
    return btmcpReadPage();
  }

  function softActEntry(command) {
    return btmcpSoftAct(command);
  }

  function semanticEntry() {
    return btmcpSemanticSnapshot();
  }

  function actOnRefEntry(command) {
    return btmcpActOnRef(command);
  }

  function watchOpened(chromeApi) {
    var opened = [];
    function onCreated(tab) {
      if (!tab || typeof tab.id !== "number") return;
      opened.push({
        chromeTabId: tab.id,
        url: tab.pendingUrl || tab.url || "",
        windowId: typeof tab.windowId === "number" ? tab.windowId : 0,
        active: tab.active === true,
      });
    }
    if (chromeApi.tabs.onCreated && chromeApi.tabs.onCreated.addListener) {
      chromeApi.tabs.onCreated.addListener(onCreated);
    }
    return {
      stop: function () {
        if (chromeApi.tabs.onCreated && chromeApi.tabs.onCreated.removeListener) {
          chromeApi.tabs.onCreated.removeListener(onCreated);
        }
      },
      list: function (selfId) {
        return opened.filter(function (tab) {
          return tab.chromeTabId !== selfId;
        });
      },
    };
  }

  function waitForTabUrl(chromeApi, tabId, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(url) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chromeApi.tabs.onUpdated) chromeApi.tabs.onUpdated.removeListener(onUpdated);
        resolve(url || "");
      }
      var timer = setTimeout(function () {
        chromeApi.tabs
          .get(tabId)
          .then(function (tab) {
            finish(tab && tab.url ? tab.url : "");
          })
          .catch(function () {
            finish("");
          });
      }, timeoutMs);
      function onUpdated(updatedId, changeInfo, tab) {
        if (String(updatedId) !== String(tabId)) return;
        if (changeInfo.status === "complete" && tab && tab.url) finish(tab.url);
      }
      if (chromeApi.tabs.onUpdated) chromeApi.tabs.onUpdated.addListener(onUpdated);
    });
  }

  async function list(chromeApi, message, respond) {
    var state = await readHumanState(chromeApi);
    var gate = BTMCP_GATES.confirmBeforeAct({
      action: "listTabs",
      popupEnabled: state.popupEnabled,
      panelEnabled: false,
      hideBanner: message && message.hideBanner === true,
    });
    if (!gate.allowed) {
      fail(respond, message.requestId, "chrome-tabs-result", gate.reason);
      return;
    }
    var before = BTMCP_SAFETY.snapshot();
    try {
      var all = await chromeApi.windows.getAll({ populate: true });
      var visible = await visibleWindowId(chromeApi, all);
      var windows = [];
      for (var i = 0; i < all.length; i++) {
        var win = all[i];
        if (!win || win.incognito === true) continue;
        if (win.type && win.type !== "normal" && win.type !== "popup") continue;
        var tabs = [];
        var raw = win.tabs || [];
        for (var t = 0; t < raw.length; t++) {
          var tab = raw[t];
          if (!tab || tab.incognito === true || typeof tab.id !== "number") continue;
          if (excluded(tab.url || "", state.excludeOrigins)) continue;
          tabs.push(serializeTab(tab, win.id));
        }
        windows.push({
          windowId: win.id,
          focused: win.focused === true,
          type: win.type || "normal",
          incognito: false,
          tabs: tabs,
        });
      }
      respond(message.requestId, {
        type: "chrome-tabs-result",
        ok: true,
        visibleWindowId: visible,
        windows: windows,
        safety: delta(before),
      });
    } catch (error) {
      fail(respond, message.requestId, "chrome-tabs-result", error);
    }
  }

  async function navigateConnected(chromeApi, message, respond) {
    var tabId = message.tabId;
    var url = message.url;
    if ((typeof tabId !== "number" && typeof tabId !== "string") || typeof url !== "string" || !url) {
      fail(respond, message.requestId, "navigate-result", "tabId and url are required");
      return;
    }
    var beforeSafety = BTMCP_SAFETY.snapshot();
    try {
      var before = await chromeApi.tabs.get(tabId);
      var wasDiscarded = Boolean(before && before.discarded);
      await BTMCP_SAFETY.tabsUpdate(chromeApi, tabId, { url: url, active: false });
      var finalUrl = await waitForTabUrl(chromeApi, tabId, 30000);
      if (!finalUrl) {
        var after = await chromeApi.tabs.get(tabId);
        finalUrl = after && after.url ? after.url : url;
      }
      respond(message.requestId, {
        type: "navigate-result",
        ok: true,
        finalUrl: finalUrl,
        wasDiscarded: wasDiscarded,
        safety: delta(beforeSafety),
      });
    } catch (error) {
      fail(respond, message.requestId, "navigate-result", error);
    }
  }

  async function navigateChrome(chromeApi, message, respond) {
    var url = message.url;
    if (typeof url !== "string" || !url) {
      fail(respond, message.requestId, "navigate-chrome-result", "url is required");
      return;
    }
    var state = await readHumanState(chromeApi);
    var creating = message.create === true || message.chromeTabId == null;
    var beforeSafety = BTMCP_SAFETY.snapshot();
    var watcher = watchOpened(chromeApi);
    try {
      var visible = await visibleWindowId(chromeApi);
      if (typeof visible !== "number") {
        throw new Error("No visible window to navigate in.");
      }
      if (creating) {
        var createdGate = BTMCP_GATES.confirmBeforeAct({
          action: "navigate",
          popupEnabled: state.popupEnabled,
          panelEnabled: false,
          creatingTab: true,
          hideBanner: message.hideBanner === true,
        });
        if (!createdGate.allowed) throw new Error(createdGate.reason);
        var created = await BTMCP_SAFETY.tabsCreate(chromeApi, {
          windowId: visible,
          url: url,
          active: false,
        });
        var createdId = created && created.id;
        if (typeof createdId !== "number") throw new Error("The browser did not return a tab id.");
        var createdUrl = await waitForTabUrl(chromeApi, createdId, 30000);
        respond(message.requestId, {
          type: "navigate-chrome-result",
          ok: true,
          chromeTabId: createdId,
          finalUrl: createdUrl || url,
          wasDiscarded: false,
          created: true,
          visibleWindowId: visible,
          openedTabs: watcher.list(createdId),
          safety: delta(beforeSafety),
        });
        return;
      }

      var chromeTabId = message.chromeTabId;
      if (typeof chromeTabId !== "number") throw new Error("chromeTabId must be a chrome.tabs id from listTabs.");
      var before = await chromeApi.tabs.get(chromeTabId);
      if (!before) throw new Error("Tab not found.");
      if (before.incognito === true) throw new Error("Incognito is skipped.");
      if (before.windowId !== visible) {
        throw new Error(
          "Background navigate stays limited to the visible window. This tab is in another window."
        );
      }
      var liveGate = BTMCP_GATES.confirmBeforeAct({
        action: "navigate",
        popupEnabled: state.popupEnabled,
        panelEnabled: false,
        approvedUrl: message.approvedUrl,
        liveUrl: before.url || "",
        hideBanner: message.hideBanner === true,
      });
      if (!liveGate.allowed) throw new Error(liveGate.reason);
      var wasDiscarded = before.discarded === true;
      await BTMCP_SAFETY.tabsUpdate(chromeApi, chromeTabId, { url: url, active: false });
      var finalUrl = await waitForTabUrl(chromeApi, chromeTabId, 30000);
      respond(message.requestId, {
        type: "navigate-chrome-result",
        ok: true,
        chromeTabId: chromeTabId,
        finalUrl: finalUrl || url,
        wasDiscarded: wasDiscarded,
        created: false,
        visibleWindowId: visible,
        openedTabs: watcher.list(chromeTabId),
        safety: delta(beforeSafety),
      });
    } catch (error) {
      fail(respond, message.requestId, "navigate-chrome-result", error);
    } finally {
      watcher.stop();
    }
  }

  function emptyRead(tab, extra) {
    return Object.assign(
      {
        chromeTabId: tab.id,
        url: typeof tab.url === "string" ? tab.url : "",
        title: typeof tab.title === "string" ? tab.title : "",
        asleep: tab.discarded === true,
        frozen: tab.frozen === true,
        skipped: null,
        headings: [],
        excerpt: "",
        snapshot: [],
        hostAccess: false,
      },
      extra || {}
    );
  }

  async function read(chromeApi, message, respond) {
    var chromeTabId = message.chromeTabId;
    if (typeof chromeTabId !== "number") {
      fail(respond, message.requestId, "chrome-tab-read-result", "chromeTabId must be a chrome.tabs id from listTabs.");
      return;
    }
    var state = await readHumanState(chromeApi);
    var beforeSafety = BTMCP_SAFETY.snapshot();
    try {
      var tab = await chromeApi.tabs.get(chromeTabId);
      if (!tab) throw new Error("Tab not found.");
      if (tab.incognito === true) throw new Error("Incognito is skipped.");
      if (excluded(tab.url || "", state.excludeOrigins)) throw new Error("origin is excluded");
      var gate = BTMCP_GATES.confirmBeforeAct({
        action: "readTab",
        popupEnabled: state.popupEnabled,
        panelEnabled: false,
        approvedUrl: message.approvedUrl,
        liveUrl: tab.url || "",
        hideBanner: message.hideBanner === true,
      });
      if (!gate.allowed) throw new Error(gate.reason);
      if (tab.discarded === true) {
        respond(message.requestId, {
          type: "chrome-tab-read-result",
          ok: true,
          safety: delta(beforeSafety),
          read: emptyRead(tab, { asleep: true, skipped: "asleep", hostAccess: true }),
        });
        return;
      }
      if (tab.frozen === true) {
        respond(message.requestId, {
          type: "chrome-tab-read-result",
          ok: true,
          safety: delta(beforeSafety),
          read: emptyRead(tab, { frozen: true, skipped: "frozen", hostAccess: true }),
        });
        return;
      }
      var blocked = unsupportedPage(tab.url || "");
      if (blocked) {
        respond(message.requestId, {
          type: "chrome-tab-read-result",
          ok: true,
          safety: delta(beforeSafety),
          read: emptyRead(tab, { skipped: blocked, hostAccess: false }),
        });
        return;
      }
      var granted = await hostGranted(chromeApi, tab.url);
      if (!granted) {
        respond(message.requestId, {
          type: "chrome-tab-read-result",
          ok: true,
          safety: delta(beforeSafety),
          read: emptyRead(tab, { skipped: "host access is not granted", hostAccess: false }),
        });
        return;
      }
      var injected = await runInTab(chromeApi, chromeTabId, "ISOLATED", readPageEntry);
      var page = injected && injected[0] && injected[0].result ? injected[0].result : {};
      respond(message.requestId, {
        type: "chrome-tab-read-result",
        ok: true,
        safety: delta(beforeSafety),
        read: emptyRead(tab, {
          asleep: false,
          frozen: false,
          skipped: null,
          hostAccess: true,
          title: page.title || tab.title || "",
          headings: Array.isArray(page.headings) ? page.headings : [],
          excerpt: typeof page.excerpt === "string" ? page.excerpt : "",
          snapshot: Array.isArray(page.snapshot) ? page.snapshot : [],
        }),
      });
    } catch (error) {
      fail(respond, message.requestId, "chrome-tab-read-result", error);
    }
  }

  async function soft(chromeApi, message, respond) {
    var chromeTabId = message.chromeTabId;
    var selector = message.selector;
    var op = message.op === "type" ? "type" : "click";
    if (typeof chromeTabId !== "number") {
      fail(respond, message.requestId, "soft-input-result", "chromeTabId must be a chrome.tabs id from listTabs.");
      return;
    }
    if (typeof selector !== "string" || !selector || selector.length > 500) {
      fail(respond, message.requestId, "soft-input-result", "selector is required");
      return;
    }
    if (op === "type" && (typeof message.text !== "string" || message.text.length > 20000)) {
      fail(respond, message.requestId, "soft-input-result", "text is required");
      return;
    }
    var state = await readHumanState(chromeApi);
    var beforeSafety = BTMCP_SAFETY.snapshot();
    try {
      var tab = await chromeApi.tabs.get(chromeTabId);
      if (!tab) throw new Error("Tab not found.");
      if (tab.incognito === true) throw new Error("Incognito is skipped.");
      if (tab.discarded === true) throw new Error("Tab is asleep. It was not reloaded.");
      if (tab.frozen === true) throw new Error("Tab is frozen and was skipped.");
      var blocked = unsupportedPage(tab.url || "");
      if (blocked) throw new Error(blocked);
      var gate = BTMCP_GATES.confirmBeforeAct({
        action: op === "type" ? "softType" : "softClick",
        popupEnabled: state.popupEnabled,
        panelEnabled: false,
        approvedUrl: message.approvedUrl,
        liveUrl: tab.url || "",
        hideBanner: message.hideBanner === true,
      });
      if (!gate.allowed) throw new Error(gate.reason);
      var granted = await hostGranted(chromeApi, tab.url);
      if (!granted) throw new Error("host access is not granted");
      var injected = await runInTab(chromeApi, chromeTabId, "MAIN", softActEntry, [
        { op: op, selector: selector, text: message.text || "", submit: message.submit === true },
      ]);
      var result = injected && injected[0] ? injected[0].result : null;
      if (!result || (result.outcome !== "worked" && result.outcome !== "needs a real gesture")) {
        throw new Error("Soft input did not report an outcome.");
      }
      if (result.outcome === "needs a real gesture" && typeof result.reason !== "string") {
        throw new Error("Soft input refused without a reason.");
      }
      respond(message.requestId, {
        type: "soft-input-result",
        ok: true,
        chromeTabId: chromeTabId,
        outcome: result.outcome,
        reason: result.outcome === "worked" ? null : result.reason,
        detail: typeof result.detail === "string" ? result.detail : "",
        trusted: false,
        safety: delta(beforeSafety),
      });
    } catch (error) {
      fail(respond, message.requestId, "soft-input-result", error);
    }
  }

  function emptySnapshot(tab, extra) {
    return Object.assign(
      {
        url: typeof tab.url === "string" ? tab.url : "",
        title: typeof tab.title === "string" ? tab.title : "",
        asleep: tab.discarded === true,
        frozen: tab.frozen === true,
        skipped: null,
        hostAccess: false,
        truncated: false,
        nodes: [],
      },
      extra || {}
    );
  }

  async function snapshot(chromeApi, message, respond) {
    var chromeTabId = message.chromeTabId;
    if (typeof chromeTabId !== "number") {
      fail(respond, message.requestId, "chrome-tab-snapshot-result", "chromeTabId must be a chrome.tabs id from listTabs.");
      return;
    }
    var state = await readHumanState(chromeApi);
    var beforeSafety = BTMCP_SAFETY.snapshot();
    try {
      var tab = await chromeApi.tabs.get(chromeTabId);
      if (!tab) throw new Error("Tab not found.");
      if (tab.incognito === true) throw new Error("Incognito is skipped.");
      if (excluded(tab.url || "", state.excludeOrigins)) throw new Error("origin is excluded");
      var gate = BTMCP_GATES.confirmBeforeAct({
        action: "readTab",
        popupEnabled: state.popupEnabled,
        panelEnabled: false,
        approvedUrl: message.approvedUrl,
        liveUrl: tab.url || "",
        hideBanner: message.hideBanner === true,
      });
      if (!gate.allowed) throw new Error(gate.reason);
      if (tab.discarded === true) {
        respond(message.requestId, {
          type: "chrome-tab-snapshot-result",
          ok: true,
          safety: delta(beforeSafety),
          snapshot: emptySnapshot(tab, { asleep: true, skipped: "asleep", hostAccess: true }),
        });
        return;
      }
      if (tab.frozen === true) {
        respond(message.requestId, {
          type: "chrome-tab-snapshot-result",
          ok: true,
          safety: delta(beforeSafety),
          snapshot: emptySnapshot(tab, { frozen: true, skipped: "frozen", hostAccess: true }),
        });
        return;
      }
      var blocked = unsupportedPage(tab.url || "");
      if (blocked) {
        respond(message.requestId, {
          type: "chrome-tab-snapshot-result",
          ok: true,
          safety: delta(beforeSafety),
          snapshot: emptySnapshot(tab, { skipped: blocked, hostAccess: false }),
        });
        return;
      }
      var granted = await hostGranted(chromeApi, tab.url);
      if (!granted) {
        respond(message.requestId, {
          type: "chrome-tab-snapshot-result",
          ok: true,
          safety: delta(beforeSafety),
          snapshot: emptySnapshot(tab, { skipped: "host access is not granted", hostAccess: false }),
        });
        return;
      }
      var injected = await runInTab(chromeApi, chromeTabId, "ISOLATED", semanticEntry);
      var page = injected && injected[0] && injected[0].result ? injected[0].result : null;
      if (!page || !Array.isArray(page.nodes)) throw new Error("The page map did not return nodes.");
      respond(message.requestId, {
        type: "chrome-tab-snapshot-result",
        ok: true,
        safety: delta(beforeSafety),
        snapshot: emptySnapshot(tab, {
          asleep: false,
          frozen: false,
          skipped: null,
          hostAccess: true,
          title: page.title || tab.title || "",
          truncated: page.truncated === true,
          nodes: page.nodes,
        }),
      });
    } catch (error) {
      fail(respond, message.requestId, "chrome-tab-snapshot-result", error);
    }
  }

  function pageDelta(beforeUrl, afterUrl, pageDeltaValue) {
    var reported = pageDeltaValue && typeof pageDeltaValue === "object" ? pageDeltaValue : {};
    var previousUrl = typeof reported.previousUrl === "string" && reported.previousUrl ? reported.previousUrl : beforeUrl;
    var nextUrl = typeof reported.url === "string" && reported.url ? reported.url : afterUrl || previousUrl;
    if (afterUrl && afterUrl !== beforeUrl) nextUrl = afterUrl;
    return {
      urlChanged: nextUrl !== previousUrl,
      previousUrl: previousUrl,
      url: nextUrl,
      consoleErrors: Array.isArray(reported.consoleErrors) ? reported.consoleErrors : [],
      failedRequests: Array.isArray(reported.failedRequests) ? reported.failedRequests : [],
    };
  }

  async function act(chromeApi, message, respond) {
    var chromeTabId = message.chromeTabId;
    var ref = message.ref;
    var op = message.op === "type" ? "type" : "click";
    if (typeof chromeTabId !== "number") {
      fail(respond, message.requestId, "act-ref-result", "chromeTabId must be a chrome.tabs id from listTabs.");
      return;
    }
    if (!btmcpValidRef(ref)) {
      fail(respond, message.requestId, "act-ref-result", "ref must be a ref from snapshotTab");
      return;
    }
    if (op === "type" && (typeof message.text !== "string" || message.text.length > 20000)) {
      fail(respond, message.requestId, "act-ref-result", "text is required");
      return;
    }
    var state = await readHumanState(chromeApi);
    var beforeSafety = BTMCP_SAFETY.snapshot();
    var beforeUrl = "";
    try {
      var tab = await chromeApi.tabs.get(chromeTabId);
      if (!tab) throw new Error("Tab not found.");
      beforeUrl = typeof tab.url === "string" ? tab.url : "";
      if (tab.incognito === true) throw new Error("Incognito is skipped.");
      if (tab.discarded === true) throw new Error("Tab is asleep. It was not reloaded.");
      if (tab.frozen === true) throw new Error("Tab is frozen and was skipped.");
      var blocked = unsupportedPage(beforeUrl);
      if (blocked) throw new Error(blocked);
      var gate = BTMCP_GATES.confirmBeforeAct({
        action: op === "type" ? "softType" : "softClick",
        popupEnabled: state.popupEnabled,
        panelEnabled: false,
        approvedUrl: message.approvedUrl,
        liveUrl: beforeUrl,
        hideBanner: message.hideBanner === true,
      });
      if (!gate.allowed) throw new Error(gate.reason);
      var granted = await hostGranted(chromeApi, beforeUrl);
      if (!granted) throw new Error("host access is not granted");
      var injected = await runInTab(chromeApi, chromeTabId, "MAIN", actOnRefEntry, [
        { op: op, ref: ref, text: message.text || "", submit: message.submit === true },
      ]);
      var result = injected && injected[0] ? injected[0].result : null;
      if (!result || (result.outcome !== "worked" && result.outcome !== "needs a real gesture")) {
        throw new Error("The action did not report an outcome.");
      }
      if (result.outcome === "needs a real gesture" && typeof result.reason !== "string") {
        throw new Error("The action refused without a reason.");
      }
      var after = await chromeApi.tabs.get(chromeTabId);
      var afterUrl = after && typeof after.url === "string" ? after.url : beforeUrl;
      respond(message.requestId, {
        type: "act-ref-result",
        ok: true,
        chromeTabId: chromeTabId,
        ref: ref,
        outcome: result.outcome,
        reason: result.outcome === "worked" ? null : result.reason,
        detail: typeof result.detail === "string" ? result.detail : "",
        trusted: false,
        delta: pageDelta(beforeUrl, afterUrl, result.delta),
        safety: delta(beforeSafety),
      });
    } catch (error) {
      fail(respond, message.requestId, "act-ref-result", error);
    }
  }

  return {
    list: list,
    read: read,
    snapshot: snapshot,
    soft: soft,
    act: act,
    navigateChrome: navigateChrome,
    navigateConnected: navigateConnected,
  };
})();
