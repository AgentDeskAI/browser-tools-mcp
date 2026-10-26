// Closes the example.com tab opened by the background-navigate probe.
// The popup may already be gone, so the timer has to live here.

const CLOSE_PREFIX = "age618-close-";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(CLOSE_PREFIX)) return;
  const tabId = Number(alarm.name.slice(CLOSE_PREFIX.length));
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.remove(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "age618-close-later") return;
  const tabId = message.tabId;
  if (!Number.isInteger(tabId)) {
    sendResponse({ ok: false });
    return;
  }
  chrome.alarms.create(`${CLOSE_PREFIX}${tabId}`, { when: Date.now() + 60_000 });
  sendResponse({ ok: true });
});
