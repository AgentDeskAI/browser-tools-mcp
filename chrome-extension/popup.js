/**
 * Toolbar popup for the no-DevTools human switch.
 *
 * The checkbox is stored in session storage, so it is off after the browser
 * quits and stays off until someone checks it. The exclude list is the
 * user's, persisted, and empty until they write one. The worker re-reads
 * both from storage; this page does not send the boolean on the wire itself.
 */
(function () {
  "use strict";

  var api = typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome;
  var allow = document.getElementById("allowPageActions");
  var exclude = document.getElementById("excludeOrigins");
  var grant = document.getElementById("grantHostAccess");
  var trackTab = document.getElementById("trackTab");
  var trackOrigin = document.getElementById("trackOrigin");
  var trackNote = document.getElementById("trackNote");
  var saved = document.getElementById("saved");

  function storageGet(area, key) {
    return new Promise(function (resolve) {
      try {
        area.get(key, function (stored) {
          resolve(stored || {});
        });
      } catch (error) {
        resolve({});
      }
    });
  }

  function storageSet(area, value) {
    return new Promise(function (resolve) {
      try {
        area.set(value, function () {
          resolve();
        });
      } catch (error) {
        resolve();
      }
    });
  }

  function parseExclude(text) {
    return text
      .split(/[\s,]+/)
      .map(function (entry) {
        return entry.trim();
      })
      .filter(Boolean);
  }

  async function notifyWorker() {
    try {
      await api.runtime.sendMessage({ type: "capability-report" });
    } catch (error) {
      /* the worker also listens for storage changes */
    }
  }

  async function notifyTimeline() {
    try {
      await api.runtime.sendMessage({ type: "timeline-sync" });
    } catch (error) {
      /* the worker also listens for storage changes */
    }
  }

  async function currentTab() {
    try {
      var tabs = await api.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (error) {
      return null;
    }
  }

  async function readTimeline() {
    var local = await storageGet(api.storage.local, BTMCP_TIMELINE.STORAGE_KEY);
    return BTMCP_TIMELINE.normalizeState(local[BTMCP_TIMELINE.STORAGE_KEY]);
  }

  async function writeTimeline(state) {
    var next = {};
    next[BTMCP_TIMELINE.STORAGE_KEY] = state;
    await storageSet(api.storage.local, next);
    await notifyTimeline();
  }

  async function init() {
    var session = await storageGet(api.storage.session, BTMCP_GATES.POPUP_SWITCH_KEY);
    var local = await storageGet(api.storage.local, BTMCP_GATES.EXCLUDE_KEY);
    allow.checked = session[BTMCP_GATES.POPUP_SWITCH_KEY] === true;
    var list = local[BTMCP_GATES.EXCLUDE_KEY];
    exclude.value = Array.isArray(list) ? list.join("\n") : "";

    allow.addEventListener("change", async function () {
      var next = {};
      next[BTMCP_GATES.POPUP_SWITCH_KEY] = allow.checked === true;
      await storageSet(api.storage.session, next);
      saved.textContent = allow.checked ? "Page actions allowed for this browser session." : "Page actions are off.";
      await notifyWorker();
    });

    exclude.addEventListener("change", async function () {
      var parsed = parseExclude(exclude.value);
      var valid = parsed.filter(function (entry) {
        return /^https?:\/\//i.test(entry);
      });
      var next = {};
      next[BTMCP_GATES.EXCLUDE_KEY] = valid;
      await storageSet(api.storage.local, next);
      exclude.value = valid.join("\n");
      saved.textContent =
        valid.length === parsed.length
          ? "Exclude list saved."
          : "Origins need an http or https scheme. The others were not saved.";
      await notifyWorker();
    });

    if (grant) {
      grant.addEventListener("click", function () {
        var request = api.permissions.request({ origins: ["<all_urls>"] });
        Promise.resolve(request)
          .then(function (granted) {
            saved.textContent = granted
              ? "Host access granted for open pages."
              : "Host access was not granted.";
          })
          .catch(function () {
            saved.textContent = "Host access was not granted.";
          });
      });
    }

    if (trackTab && trackOrigin) {
      var tab = await currentTab();
      var origin = tab ? BTMCP_GATES.originOf(tab.url || "") : null;
      var timeline = await readTimeline();
      if (!origin || !tab) {
        trackTab.disabled = true;
        trackOrigin.disabled = true;
        trackNote.textContent = "This page can't be logged. Open an http or https tab.";
      } else {
        trackTab.checked = Boolean(timeline.tabs[String(tab.id)]);
        trackOrigin.checked = Boolean(timeline.origins[origin]);
        trackTab.addEventListener("change", async function () {
          var live = await currentTab();
          var liveOrigin = live ? BTMCP_GATES.originOf(live.url || "") : null;
          if (!live || !liveOrigin) {
            trackTab.checked = false;
            saved.textContent = "This page can't be logged.";
            return;
          }
          var state = await readTimeline();
          if (trackTab.checked) {
            state.tabs[String(live.id)] = {
              origin: liveOrigin,
              url: live.url || "",
              title: live.title || "",
              enabledAt: Date.now(),
            };
            saved.textContent = "This tab will be logged for 8 hours.";
          } else {
            delete state.tabs[String(live.id)];
            saved.textContent = "This tab is no longer logged.";
          }
          await writeTimeline(state);
        });
        trackOrigin.addEventListener("change", async function () {
          var live = await currentTab();
          var liveOrigin = live ? BTMCP_GATES.originOf(live.url || "") : null;
          if (!liveOrigin) {
            trackOrigin.checked = false;
            saved.textContent = "This site can't be logged.";
            return;
          }
          var state = await readTimeline();
          if (trackOrigin.checked) {
            state.origins[liveOrigin] = { enabledAt: Date.now() };
            saved.textContent = "This site will be logged for 8 hours.";
          } else {
            delete state.origins[liveOrigin];
            saved.textContent = "This site is no longer logged.";
          }
          await writeTimeline(state);
        });
      }
    }

    document.documentElement.dataset.ready = "true";
  }

  void init();
})();
