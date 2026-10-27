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

    document.documentElement.dataset.ready = "true";
  }

  void init();
})();
