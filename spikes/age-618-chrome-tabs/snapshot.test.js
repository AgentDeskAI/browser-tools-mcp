import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SURFACES,
  TAB_TOOL_DESCRIPTION,
  VISIBLE_WINDOW_LIMIT,
  appearedSince,
  coverageDelta,
  decision,
  emptyState,
  findingsTemplate,
  focusDelta,
  originOf,
  otherSpaceStillListed,
  pickCreateWindow,
  pickProbeTarget,
  probeReading,
  spaceOverlap,
  summarizeTab,
  summarizeWindows,
  toMarkdown,
} from "./snapshot.js";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

test("manifest stays a tabs-only spike", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["tabs", "tabGroups", "storage", "alarms"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.devtools_page, undefined);
  assert.equal(manifest.background.service_worker, "sw.js");
  assert.equal(manifest.action.default_popup, "popup.html");
});

test("origin keeps the site and drops the path and query", () => {
  assert.equal(originOf("https://mail.example.com/inbox?token=secret"), "https://mail.example.com");
  assert.equal(originOf("http://localhost:3000/a"), "http://localhost:3000");
  assert.equal(originOf("chrome://extensions/"), "chrome://extensions");
  assert.equal(originOf(""), "");
  assert.equal(originOf("not a url"), "(unparsed)");
});

test("summaries omit titles and full URLs", () => {
  const summary = summarizeWindows([
    {
      id: 1,
      focused: true,
      type: "normal",
      incognito: false,
      state: "normal",
      tabs: [
        {
          id: 7,
          index: 0,
          active: true,
          pinned: true,
          discarded: false,
          frozen: false,
          groupId: -1,
          title: "Secret title",
          url: "https://bank.example/account?id=99",
          pendingUrl: "https://bank.example/account?id=99",
        },
      ],
    },
  ]);
  const encoded = JSON.stringify(summary);
  assert.equal(encoded.includes("Secret"), false);
  assert.equal(encoded.includes("account"), false);
  assert.equal(encoded.includes("id=99"), false);
  assert.equal(summary.windows[0].tabs[0].origin, "https://bank.example");
  assert.equal(summary.tabCount, 1);
});

test("a missing frozen field is recorded as unknown rather than false", () => {
  const tab = summarizeTab({ id: 1, url: "https://example.com/" });
  assert.equal(tab.frozen, null);
  assert.equal(tab.discarded, null);
  assert.equal(tab.pinned, false);
});

test("window types outside normal and popup are called out", () => {
  const delta = coverageDelta(
    [{ id: 1, type: "normal" }],
    [
      { id: 1, type: "normal" },
      { id: 2, type: "panel" },
    ],
  );
  assert.deepEqual(delta.onlyInAllTypes, [{ id: 2, type: "panel" }]);
});

test("switching Space drops the first Space's tab ids", () => {
  const first = summarizeWindows([{ id: 1, type: "normal", tabs: [{ id: 10, url: "https://a.example/" }] }]);
  const second = summarizeWindows([{ id: 1, type: "normal", tabs: [{ id: 11, url: "https://b.example/" }] }]);
  assert.deepEqual(spaceOverlap(first, second), { shared: 0, onlyInFirst: 1, onlyInSecond: 1 });
  const state = emptyState();
  state.snapshots["this-space"] = { allTypes: first };
  state.snapshots["second-space"] = { allTypes: second };
  assert.match(otherSpaceStillListed(state), /^no/);
  const appeared = appearedSince(first, second);
  assert.equal(appeared.tabs.length, 1);
  assert.equal(appeared.tabs[0].origin, "https://b.example");
});

test("probe target prefers an inactive tab in another window", () => {
  const summary = summarizeWindows([
    { id: 1, focused: true, type: "normal", tabs: [{ id: 1, active: true, url: "https://here.example/" }] },
    { id: 2, focused: false, type: "normal", tabs: [{ id: 2, active: false, url: "https://there.example/" }] },
  ]);
  const target = pickProbeTarget(summary, {}, 1);
  assert.equal(target.tabId, 2);
  assert.equal(target.reachesOtherWindow, true);
  assert.equal(pickCreateWindow(summary, 1).windowId, 2);
});

test("an inactive tab in the focused window is not treated as another Space", () => {
  const summary = summarizeWindows([
    {
      id: 1,
      focused: true,
      type: "normal",
      tabs: [
        { id: 1, active: true, url: "https://here.example/" },
        { id: 2, active: false, url: "https://also.example/" },
      ],
    },
  ]);
  const target = pickProbeTarget(summary, {}, 1);
  assert.equal(target.reachesOtherWindow, false);
  assert.equal(pickCreateWindow(summary, 1).reachesOtherWindow, false);
});

test("focus delta notices a window switch and ignores an unchanged active tab", () => {
  assert.deepEqual(
    focusDelta({ focusedWindowId: 1, activeTabIds: [5] }, { focusedWindowId: 2, activeTabIds: [5] }),
    { focusedWindowChanged: true, activeTabChanged: false },
  );
  assert.equal(
    probeReading({
      spaceSwitched: "yes",
      reachesOtherWindow: true,
      afterCreate: { focusedWindowChanged: false, activeTabChanged: false },
    }).includes(VISIBLE_WINDOW_LIMIT),
    true,
  );
});

test("unmeasured state keeps navigate on the visible window and names the gap", () => {
  const text = decision(emptyState());
  assert.match(text, new RegExp(VISIBLE_WINDOW_LIMIT.replace(".", "\\.")));
  assert.match(text, /Other Arc Spaces may be missing/);
  assert.match(text, /Neither probe has been run/);
  assert.match(toMarkdown(emptyState()), new RegExp(TAB_TOOL_DESCRIPTION.replace(".", "\\.")));
  for (const surface of SURFACES) assert.match(toMarkdown(emptyState()), new RegExp(surface.label));
});

test("a same-window probe does not clear other Spaces", () => {
  const state = emptyState();
  state.probes.push({
    kind: "update-active-false",
    reachesOtherWindow: false,
    spaceSwitched: "no",
    afterCreate: { focusedWindowChanged: false, activeTabChanged: false },
  });
  assert.match(decision(state), /did not clear other Spaces/);
  assert.match(probeReading(state.probes[0]), /focused window/);
});

test("markdown rows stay rectangular and the template stays unmeasured", () => {
  const table = toMarkdown({
    ...emptyState(),
    browser: "Arc 1.170",
    notes: { "little-arc": "sidebar had one | extra" },
    snapshots: {
      "little-arc": {
        takenAt: "2026-10-26T00:00:00.000Z",
        defaultFilter: summarizeWindows([{ id: 1, type: "normal", tabs: [] }]),
        allTypes: summarizeWindows([
          { id: 1, type: "normal", tabs: [] },
          { id: 9, type: "popup", tabs: [{ id: 3, url: "https://little.example/path", discarded: true, frozen: false, pinned: false, groupId: -1 }] },
        ]),
        coverage: { onlyInAllTypes: [] },
        previous: summarizeWindows([{ id: 1, type: "normal", tabs: [] }]),
        queryTabCount: 1,
      },
    },
  });
  const visibility = table.split("### Probes")[0];
  const rows = visibility.split("\n").filter((line) => line.startsWith("| "));
  const widths = new Set(rows.map((line) => line.split("|").length));
  assert.equal(widths.size, 1);
  assert.equal([...widths][0], 12);
  assert.match(table, /new windows: popup#9/);
  assert.equal(table.includes("little.example/path"), false);
  assert.match(findingsTemplate(), /unmeasured/);
  assert.match(findingsTemplate(), new RegExp(VISIBLE_WINDOW_LIMIT.replace(".", "\\.")));
});
