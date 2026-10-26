import {
  SURFACES,
  coverageDelta,
  emptyState,
  focusDelta,
  pickCreateWindow,
  pickProbeTarget,
  summarizeWindows,
  toMarkdown,
} from "./snapshot.js";

const STORAGE_KEY = "age618";
const ALL_TYPES = ["normal", "popup", "panel", "app", "devtools"];

const browserInput = document.querySelector("#browser");
const live = document.querySelector("#live");
const surfaces = document.querySelector("#surfaces");
const markdown = document.querySelector("#markdown");
const status = document.querySelector("#status");
const probeQuestion = document.querySelector("#probe-question");
const probePrompt = document.querySelector("#probe-prompt");

let state = emptyState();
let resetArmed = false;

function setStatus(text) {
  status.textContent = text || "";
}

async function load() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state = { ...emptyState(), ...(stored[STORAGE_KEY] ?? {}) };
  state.userAgent = navigator.userAgent;
  browserInput.value = state.browser || "";
  renderSurfaces();
  await refreshLive();
  showPending();
  renderMarkdown();
}

async function save() {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  renderMarkdown();
}

function renderSurfaces() {
  surfaces.replaceChildren();
  for (const surface of SURFACES) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = surface.label;
    const taken = state.snapshots[surface.id]?.takenAt;
    if (taken) button.textContent += " ✓";
    button.addEventListener("click", () => capture(surface.id));
    const hint = document.createElement("span");
    hint.textContent = surface.hint;
    const note = document.createElement("input");
    note.type = "text";
    note.placeholder = "What the sidebar showed";
    note.value = state.notes[surface.id] || "";
    note.addEventListener("input", () => {
      state.notes[surface.id] = note.value;
      save().catch((error) => setStatus(error.message));
    });
    item.append(button, hint, note);
    surfaces.append(item);
  }
}

function renderMarkdown() {
  markdown.value = toMarkdown(state);
}

async function refreshLive() {
  try {
    const summary = summarizeWindows(await chrome.windows.getAll({ populate: true }));
    const focused = summary.windows.find((win) => win.focused);
    live.textContent = `${summary.windowCount} windows, ${summary.tabCount} tabs in the normal/popup filter. Focused window: ${focused ? focused.id : "none"}.`;
  } catch (error) {
    live.textContent = error.message;
  }
}

async function readBrowser() {
  const [defaultWindows, allTypesResult, queried, groups, focused] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    chrome.windows.getAll({ populate: true, windowTypes: ALL_TYPES }).then(
      (windows) => ({ windows, error: null }),
      (error) => ({ windows: null, error: error.message }),
    ),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}).catch((error) => ({ error: error.message })),
    chrome.windows.getLastFocused({}).catch(() => null),
  ]);
  const allTypesWindows = allTypesResult.windows ?? defaultWindows;
  return {
    defaultFilter: summarizeWindows(defaultWindows),
    allTypes: summarizeWindows(allTypesWindows),
    allTypesError: allTypesResult.error,
    coverage: coverageDelta(defaultWindows, allTypesWindows),
    queryTabCount: queried.length,
    focusedWindowId: focused?.id ?? null,
    activeTabIds: queried.filter((tab) => tab.active).map((tab) => tab.id),
    tabGroupCount: Array.isArray(groups) ? groups.length : 0,
    tabGroupError: Array.isArray(groups) ? null : groups.error,
  };
}

function previousSummary(exceptId) {
  const prior = Object.entries(state.snapshots)
    .filter(([id, snap]) => id !== exceptId && snap?.takenAt)
    .sort((a, b) => String(a[1].takenAt).localeCompare(String(b[1].takenAt)))
    .at(-1);
  return prior?.[1]?.allTypes ?? null;
}

async function capture(surfaceId) {
  setStatus("");
  try {
    const reading = await readBrowser();
    state.browser = browserInput.value.trim();
    state.userAgent = navigator.userAgent;
    state.snapshots[surfaceId] = {
      ...reading,
      takenAt: new Date().toISOString(),
      previous: previousSummary(surfaceId),
    };
    await save();
    renderSurfaces();
    await refreshLive();
    const summary = reading.allTypes;
    setStatus(`Saved. ${summary.windowCount} windows, ${summary.tabCount} tabs.`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function probeUpdate() {
  setStatus("");
  try {
    const before = await readBrowser();
    const target = pickProbeTarget(before.allTypes, state.snapshots, before.focusedWindowId);
    if (!target) {
      state.probes = state.probes.filter((probe) => probe.kind !== "update-active-false");
      state.probes.push({
        kind: "update-active-false",
        noTargetReason: "No inactive tab was listed, so there was nothing to update.",
        spaceSwitched: null,
        reachesOtherWindow: false,
      });
      await save();
      setStatus("No inactive tab to probe.");
      return;
    }
    await chrome.tabs.update(target.tabId, { active: false });
    await delay(400);
    const after = await readBrowser();
    const delta = focusDelta(before, after);
    state.probes = state.probes.filter((probe) => probe.kind !== "update-active-false");
    state.probes.push({
      kind: "update-active-false",
      tabId: target.tabId,
      windowId: target.windowId,
      origin: target.origin,
      reachesOtherWindow: target.reachesOtherWindow,
      spaceSwitched: null,
      afterCreate: delta,
    });
    await save();
    askSpace("Did the browser switch Space when active was set to false?");
  } catch (error) {
    setStatus(error.message);
  }
}

async function probeCreate() {
  setStatus("");
  try {
    const before = await readBrowser();
    const target = pickCreateWindow(before.allTypes, before.focusedWindowId);
    if (!target) {
      setStatus("No window to open a probe tab in.");
      return;
    }
    const created = await chrome.tabs.create({
      windowId: target.windowId,
      url: "https://example.com/",
      active: false,
    });
    chrome.runtime.sendMessage({ type: "age618-close-later", tabId: created.id }).catch(() => {});
    await delay(500);
    const after = await readBrowser();
    state.probes = state.probes.filter((probe) => probe.kind !== "create-background");
    state.probes.push({
      kind: "create-background",
      createdTabId: created.id,
      windowId: target.windowId,
      reachesOtherWindow: target.reachesOtherWindow,
      spaceSwitched: null,
      afterCreate: focusDelta(before, after),
      afterClose: null,
    });
    await save();
    askSpace("example.com was opened unfocused. Did the browser switch Space? Answering closes that tab.");
  } catch (error) {
    setStatus(error.message);
  }
}

function pendingProbe() {
  return [...(state.probes ?? [])].reverse().find((probe) => probe.spaceSwitched == null && !probe.noTargetReason);
}

function showPending() {
  const probe = pendingProbe();
  probeQuestion.hidden = !probe;
  document.querySelector("#probe-update").disabled = Boolean(probe);
  document.querySelector("#probe-create").disabled = Boolean(probe);
  if (!probe) return;
  probePrompt.textContent =
    probe.kind === "create-background"
      ? "example.com is open in the background. Did the browser switch Space?"
      : "Did the browser switch Space on tabs.update({active:false})?";
}

function askSpace(prompt) {
  probePrompt.textContent = prompt;
  probeQuestion.hidden = false;
  document.querySelector("#probe-update").disabled = true;
  document.querySelector("#probe-create").disabled = true;
}

async function answerSpace(answer) {
  const probe = pendingProbe();
  if (!probe) return;
  probe.spaceSwitched = answer;
  if (probe.kind === "create-background" && Number.isInteger(probe.createdTabId)) {
    const beforeClose = await readBrowser();
    try {
      await chrome.alarms.clear(`age618-close-${probe.createdTabId}`);
    } catch {
      // The alarm is only a backstop.
    }
    try {
      await chrome.tabs.remove(probe.createdTabId);
    } catch {
      // Already gone.
    }
    await delay(300);
    const after = await readBrowser();
    probe.afterClose = focusDelta(beforeClose, after);
  }
  await save();
  showPending();
  setStatus(answer === "yes" ? "Recorded: the Space switched." : "Recorded: the Space stayed.");
}

async function discardBackground() {
  setStatus("");
  try {
    const tabs = await chrome.tabs.query({ active: false, discarded: false });
    const candidate = tabs.find((tab) => !tab.incognito) ?? tabs[0];
    if (!candidate) {
      setStatus("No background tab to discard.");
      return;
    }
    await chrome.tabs.discard(candidate.id);
    await capture("slept");
    setStatus("Discarded a background tab and saved the slept snapshot.");
  } catch (error) {
    setStatus(error.message);
  }
}

async function copyMarkdown() {
  markdown.focus();
  markdown.select();
  try {
    await navigator.clipboard.writeText(markdown.value);
    setStatus("Copied. Review origins before pasting into Linear.");
  } catch (error) {
    setStatus(`Clipboard failed (${error.message}). The text is selected.`);
  }
}

function saveJson() {
  const blob = new Blob([JSON.stringify({ ...state, decision: markdown.value }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "age-618-chrome-tabs.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function reset() {
  if (!resetArmed) {
    resetArmed = true;
    setStatus("Click Reset again to erase the snapshots on this browser.");
    return;
  }
  resetArmed = false;
  state = emptyState();
  state.userAgent = navigator.userAgent;
  browserInput.value = "";
  await chrome.storage.local.remove(STORAGE_KEY);
  renderSurfaces();
  showPending();
  renderMarkdown();
  await refreshLive();
  setStatus("Erased.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

browserInput.addEventListener("change", () => {
  state.browser = browserInput.value.trim();
  save().catch((error) => setStatus(error.message));
});
document.querySelector("#probe-update").addEventListener("click", () => probeUpdate());
document.querySelector("#probe-create").addEventListener("click", () => probeCreate());
document.querySelector("#discard").addEventListener("click", () => discardBackground());
document.querySelector("#space-no").addEventListener("click", () => answerSpace("no"));
document.querySelector("#space-yes").addEventListener("click", () => answerSpace("yes"));
document.querySelector("#copy").addEventListener("click", () => copyMarkdown());
document.querySelector("#save-json").addEventListener("click", () => saveJson());
document.querySelector("#reset").addEventListener("click", () => reset());

load().catch((error) => setStatus(error.message));
