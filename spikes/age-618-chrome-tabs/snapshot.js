// Pure helpers for the AGE-618 spike. No chrome.* calls, so node can test them.

export const TAB_TOOL_DESCRIPTION =
  "Tabs the browser exposes through chrome.tabs in the windows it returns. " +
  "Other Arc Spaces, Little Arc, pinned favorites, split-view partners, and slept tabs may be missing. " +
  "Incognito is skipped. This is not every open tab.";

export const VISIBLE_WINDOW_LIMIT =
  "Background navigate stays limited to the visible window.";

export const SURFACES = [
  {
    id: "this-space",
    label: "Current Space, unpinned tabs",
    hint: "Stay in the Space you are already viewing.",
  },
  {
    id: "second-space",
    label: "Second Space, while you are viewing it",
    hint: "Switch to a different Space. Do not click its tabs. Then snapshot.",
  },
  {
    id: "little-arc",
    label: "Little Arc",
    hint: "Open a Little Arc and leave it up. Then snapshot.",
  },
  {
    id: "favorite",
    label: "Pinned favorite that is not an open tab",
    hint: "Look at a sidebar favorite you have not opened as a tab.",
  },
  {
    id: "split",
    label: "Split view, the other pane",
    hint: "Split the current tab. Snapshot while both panes are open.",
  },
  {
    id: "slept",
    label: "Slept, archived, or discarded tab",
    hint: "Sleep a tab from Arc if you can, or use Discard background tab.",
  },
];

const WINDOW_TYPES = ["normal", "popup", "panel", "app", "devtools"];

export function originOf(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return "(unparsed)";
  }
}

export function summarizeTab(tab) {
  return {
    id: tab.id ?? null,
    index: tab.index ?? null,
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    discarded: typeof tab.discarded === "boolean" ? tab.discarded : null,
    frozen: typeof tab.frozen === "boolean" ? tab.frozen : null,
    groupId: typeof tab.groupId === "number" ? tab.groupId : null,
    status: tab.status ?? null,
    origin: originOf(tab.pendingUrl || tab.url || ""),
  };
}

export function summarizeWindow(win) {
  const tabs = Array.isArray(win.tabs) ? win.tabs.map(summarizeTab) : [];
  return {
    id: win.id ?? null,
    type: win.type ?? null,
    incognito: Boolean(win.incognito),
    focused: Boolean(win.focused),
    state: win.state ?? null,
    tabCount: tabs.length,
    tabs,
  };
}

export function summarizeWindows(windows) {
  const list = (Array.isArray(windows) ? windows : []).map(summarizeWindow);
  return {
    windowCount: list.length,
    tabCount: list.reduce((sum, win) => sum + win.tabCount, 0),
    windows: list,
  };
}

export function coverageDelta(defaultWindows, allTypeWindows) {
  const fallback = Array.isArray(defaultWindows) ? defaultWindows : [];
  const wider = Array.isArray(allTypeWindows) ? allTypeWindows : fallback;
  const seen = new Set(fallback.map((win) => win.id));
  const onlyInAllTypes = wider
    .filter((win) => !seen.has(win.id))
    .map((win) => ({ id: win.id ?? null, type: win.type ?? null }));
  return {
    defaultCount: fallback.length,
    allTypesCount: wider.length,
    onlyInAllTypes,
    queriedWindowTypes: WINDOW_TYPES,
  };
}

export function tabIds(summary) {
  const ids = new Set();
  for (const win of summary?.windows ?? []) {
    for (const tab of win.tabs ?? []) {
      if (typeof tab.id === "number") ids.add(tab.id);
    }
  }
  return ids;
}

export function appearedSince(previous, current) {
  if (!previous || !current) {
    return { windows: [], tabs: [] };
  }
  const oldWindows = new Set((previous.windows ?? []).map((win) => win.id));
  const oldTabs = tabIds(previous);
  return {
    windows: (current.windows ?? [])
      .filter((win) => !oldWindows.has(win.id))
      .map((win) => ({ id: win.id, type: win.type, incognito: win.incognito, tabCount: win.tabCount })),
    tabs: (current.windows ?? []).flatMap((win) =>
      (win.tabs ?? [])
        .filter((tab) => !oldTabs.has(tab.id))
        .map((tab) => ({
          id: tab.id,
          windowId: win.id,
          windowType: win.type,
          origin: tab.origin,
          pinned: tab.pinned,
          discarded: tab.discarded,
          frozen: tab.frozen,
          groupId: tab.groupId,
          active: tab.active,
        })),
    ),
  };
}

export function spaceOverlap(before, after) {
  if (!before || !after) return null;
  const idsA = tabIds(before);
  const idsB = tabIds(after);
  let shared = 0;
  for (const id of idsA) if (idsB.has(id)) shared += 1;
  return {
    shared,
    onlyInFirst: idsA.size - shared,
    onlyInSecond: idsB.size - shared,
  };
}

export function pickProbeTarget(summary, snapshots, focusedWindowId) {
  const earlier = new Set();
  for (const snap of Object.values(snapshots ?? {})) {
    for (const id of tabIds(snap)) earlier.add(id);
  }
  const tabs = (summary?.windows ?? []).flatMap((win) =>
    (win.tabs ?? []).map((tab) => ({
      tabId: tab.id,
      windowId: win.id,
      origin: tab.origin,
      active: tab.active,
      reachesOtherWindow: win.id !== focusedWindowId,
      seenEarlier: earlier.has(tab.id),
    })),
  );
  const inactive = tabs.filter((tab) => tab.tabId != null && !tab.active);
  const ranked = [
    ...inactive.filter((tab) => tab.reachesOtherWindow && tab.seenEarlier),
    ...inactive.filter((tab) => tab.reachesOtherWindow),
    ...inactive,
  ];
  return ranked[0] ?? null;
}

export function pickCreateWindow(summary, focusedWindowId) {
  const windows = summary?.windows ?? [];
  const other = windows.find((win) => win.id !== focusedWindowId && win.type !== "devtools");
  if (other) return { windowId: other.id, type: other.type, reachesOtherWindow: true };
  const focused = windows.find((win) => win.id === focusedWindowId) ?? windows[0];
  if (!focused || focused.id == null) return null;
  return { windowId: focused.id, type: focused.type, reachesOtherWindow: false };
}

export function focusDelta(before, after) {
  const beforeIds = before?.activeTabIds ?? [];
  const afterIds = after?.activeTabIds ?? [];
  const afterSet = new Set(afterIds);
  const activeTabChanged =
    beforeIds.length !== afterIds.length || beforeIds.some((id) => !afterSet.has(id));
  return {
    focusedWindowChanged: (before?.focusedWindowId ?? null) !== (after?.focusedWindowId ?? null),
    activeTabChanged,
  };
}

function flagSet(summary, key) {
  const values = new Set();
  for (const win of summary?.windows ?? []) {
    for (const tab of win.tabs ?? []) values.add(tab[key]);
  }
  return [...values].sort((a, b) => String(a).localeCompare(String(b)));
}

function formatFlags(summary, key) {
  const tabs = (summary?.windows ?? []).flatMap((win) => win.tabs ?? []);
  if (tabs.length === 0) return "—";
  const present = flagSet(summary, key).filter((value) => value !== null && value !== undefined);
  return present.length ? present.join("/") : "unsupported";
}

function formatGroups(summary) {
  const ids = (summary?.windows ?? []).flatMap((win) => win.tabs ?? []).map((tab) => tab.groupId);
  if (ids.length === 0) return "—";
  if (ids.every((id) => id == null)) return "unsupported";
  const grouped = [...new Set(ids.filter((id) => typeof id === "number" && id !== -1))];
  return grouped.length ? grouped.join(",") : "none";
}

function surfaceRow(state, surface) {
  const snap = state.snapshots?.[surface.id];
  const note = (state.notes?.[surface.id] ?? "").trim();
  if (!snap) {
    return `| ${surface.label} | ${escapeCell(note || "—")} | — | — | — | — | — | — | — | not taken |`;
  }
  const summary = snap.allTypes ?? snap.defaultFilter;
  const appeared = appearedSince(snap.previous, summary);
  const auto = [];
  if (appeared.windows.length) {
    auto.push(`new windows: ${appeared.windows.map((win) => `${win.type}#${win.id}`).join(", ")}`);
  }
  if (appeared.tabs.length) auto.push(`new tabs: ${appeared.tabs.length}`);
  if (snap.allTypesError) auto.push(`all-types query failed: ${snap.allTypesError}`);
  const extra = snap.coverage?.onlyInAllTypes ?? [];
  if (extra.length) auto.push(`outside normal/popup: ${extra.map((win) => win.type).join(", ")}`);
  if (
    typeof snap.queryTabCount === "number" &&
    snap.allTypes &&
    snap.queryTabCount !== snap.allTypes.tabCount
  ) {
    auto.push(`tabs.query ${snap.queryTabCount} vs getAll ${snap.allTypes.tabCount}`);
  }
  if (snap.tabGroupError) auto.push(`tabGroups: ${snap.tabGroupError}`);
  return [
    surface.label,
    escapeCell(note || "—"),
    snap.defaultFilter?.tabCount ?? "—",
    snap.allTypes?.tabCount ?? "—",
    extra.length ? extra.map((win) => win.type).join(", ") : "none",
    formatFlags(summary, "discarded"),
    formatFlags(summary, "frozen"),
    formatFlags(summary, "pinned"),
    formatGroups(summary),
    escapeCell(auto.join("; ") || "—"),
  ]
    .map((cell) => `| ${cell}`)
    .join(" ") + " |";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "/").replaceAll("\n", " ");
}

export function probeReading(probe) {
  if (!probe) return "Not run. " + VISIBLE_WINDOW_LIMIT;
  if (probe.error) return `${probe.error} ${VISIBLE_WINDOW_LIMIT}`;
  if (probe.noTargetReason) return `${probe.noTargetReason} ${VISIBLE_WINDOW_LIMIT}`;
  const created = probe.afterCreate ?? probe;
  const interrupted =
    probe.spaceSwitched === "yes" || created.focusedWindowChanged || created.activeTabChanged;
  if (interrupted) {
    return `The browser moved. ${VISIBLE_WINDOW_LIMIT}`;
  }
  if (probe.spaceSwitched !== "no") {
    return `The API focus did not change, and whether the Space switched is still unanswered. ${VISIBLE_WINDOW_LIMIT}`;
  }
  if (!probe.reachesOtherWindow) {
    return `No interruption, and the target was the focused window, so other Spaces are still unproven. ${VISIBLE_WINDOW_LIMIT}`;
  }
  const closed = probe.afterClose;
  if (closed && (closed.focusedWindowChanged || closed.activeTabChanged)) {
    return `Opening did not move focus, but closing the probe tab did. ${VISIBLE_WINDOW_LIMIT}`;
  }
  return "No focus change, and the Space stayed put, on a target outside the focused window. Repeat on the next browser before widening navigate.";
}

export function otherSpaceStillListed(state) {
  const overlap = spaceOverlap(state.snapshots?.["this-space"]?.allTypes, state.snapshots?.["second-space"]?.allTypes);
  if (!overlap) return "not taken";
  if (overlap.onlyInFirst === 0 && overlap.shared > 0) return "yes — every tab from the first Space was still listed";
  if (overlap.onlyInFirst > 0 && overlap.shared === 0) return "no — the first Space's tabs were gone after the switch";
  if (overlap.onlyInFirst > 0) return `partial — ${overlap.onlyInFirst} first-Space tabs disappeared, ${overlap.shared} remained`;
  return "unclear — the first snapshot had no tab ids";
}

export function decision(state) {
  const probes = state.probes ?? [];
  const overlap = otherSpaceStillListed(state);
  const parts = [VISIBLE_WINDOW_LIMIT, "Other Arc Spaces may be missing."];
  if (overlap.startsWith("no") || overlap.startsWith("partial")) {
    parts.push(`After switching Space: ${overlap}.`);
  }
  if (probes.length === 0) {
    parts.push("Neither probe has been run.");
    return parts.join(" ");
  }
  const update = probes.find((probe) => probe.kind === "update-active-false");
  const created = probes.find((probe) => probe.kind === "create-background");
  const readings = [update, created].filter(Boolean).map((probe) => probeReading(probe));
  if (readings.some((line) => line.startsWith("The browser moved") || line.includes("closing the probe tab did"))) {
    parts.push("A probe interrupted the browser.");
    return parts.join(" ");
  }
  if (
    update &&
    created &&
    readings.length === 2 &&
    readings.every((line) => line.startsWith("No focus change, and the Space stayed put"))
  ) {
    const dropped = overlap.startsWith("no") || overlap.startsWith("partial") ? ` Switching Space dropped tabs (${overlap}).` : "";
    return `Both probes targeted a window that was not focused and did not switch Space.${dropped} ${VISIBLE_WINDOW_LIMIT} Repeat on the next browser before treating this as cleared.`;
  }
  parts.push("Probes so far did not clear other Spaces.");
  return parts.join(" ");
}

export function emptyState() {
  return { browser: "", userAgent: "", snapshots: {}, notes: {}, probes: [] };
}

export function toMarkdown(state) {
  const browser = (state.browser || "").trim() || "(browser name not set)";
  const lines = [
    `## chrome.tabs spike — ${browser}`,
    "",
    TAB_TOOL_DESCRIPTION,
    "",
    `User agent: ${state.userAgent || "—"}`,
    "",
    "### Visibility",
    "",
    "| Surface | Sidebar note | Tabs (normal+popup) | Tabs (all window types) | Extra types | discarded | frozen | pinned | groupId | What appeared |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...SURFACES.map((surface) => surfaceRow(state, surface)),
    "",
    `Other Space still listed after the switch: ${otherSpaceStillListed(state)}.`,
    "",
    "### Probes",
    "",
    "| Probe | Target outside the focused window? | Focused window changed | Active tab changed | Space switched | Reading |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const update = (state.probes ?? []).find((probe) => probe.kind === "update-active-false");
  const created = (state.probes ?? []).find((probe) => probe.kind === "create-background");
  lines.push(probeRow("tabs.update({active:false})", update));
  lines.push(probeRow("tabs.create example.com active:false, then close", created));
  lines.push("", "### Decision", "", decision(state), "");
  return lines.join("\n");
}

function probeRow(label, probe) {
  if (!probe) return `| ${label} | — | — | — | — | not run |`;
  const delta = probe.afterCreate ?? probe;
  const target = probe.noTargetReason
    ? "no target"
    : probe.reachesOtherWindow
      ? "yes"
      : "no";
  return `| ${label} | ${target} | ${yesNo(delta.focusedWindowChanged)} | ${yesNo(delta.activeTabChanged)} | ${probe.spaceSwitched ?? "unanswered"} | ${escapeCell(probeReading(probe))} |`;
}

function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "—";
}

export function findingsTemplate() {
  return [
    "| Surface | Arc | Next browser | Notes |",
    "| --- | --- | --- | --- |",
    "| Current Space, unpinned tabs | unmeasured | unmeasured | |",
    "| Second Space, while you are not viewing it | unmeasured | unmeasured | Snapshot while viewing the other Space. If the first Space's tab ids disappear, this cell is not visible. |",
    "| Little Arc | unmeasured | unmeasured | Leave Little Arc open while you snapshot. |",
    "| Pinned favorite that is not an open tab | unmeasured | unmeasured | |",
    "| Split view, the pane you are not interacting with | unmeasured | unmeasured | |",
    "| Slept, archived, or discarded tab | unmeasured | unmeasured | Record discarded and frozen, or gone. |",
    "| Incognito window | unmeasured | unmeasured | Hidden unless this extension is allowed in private mode. |",
    "",
    "| Probe | Arc: Space or focus changed? | Next browser | Decision until measured |",
    "| --- | --- | --- | --- |",
    `| tabs.update({active:false}) on a tab outside the visible Space | unmeasured | unmeasured | ${VISIBLE_WINDOW_LIMIT} |`,
    `| tabs.create({active:false, url: https://example.com/}) in a non-focused window, then close it | unmeasured | unmeasured | ${VISIBLE_WINDOW_LIMIT} |`,
  ].join("\n");
}
