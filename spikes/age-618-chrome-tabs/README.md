# AGE-618 chrome.tabs spike

Unpacked extension that records what `chrome.windows.getAll({ populate: true })` returns. It is the measurement for [AGE-618](https://linear.app/agentdesk/issue/AGE-618), before tab tools claim they can see every tab.

It does not use `chrome.debugger`, does not read page contents, and does not change the URL of a tab you already have open. The only tab it creates is `https://example.com/`, unfocused, and it closes that tab when you answer the Space question (or after 60 seconds).

Permissions: `tabs` (the API under test), `tabGroups` (split view may or may not be a Chrome tab group), `storage` (keeps the six snapshots), `alarms` (closes the example.com probe tab).

## Load it

1. Open `chrome://extensions` (Arc accepts that URL).
2. Turn on Developer mode.
3. Load unpacked and choose this folder: `spikes/age-618-chrome-tabs`.
4. Pin **AGE-618 chrome.tabs spike**. Leave the extension off in incognito unless you want that row. Private windows stay hidden until you allow it.

Set **Browser name** before the first snapshot (`Arc 1.170`, then later `Chrome`, `Dia`, or `Helium`). One browser per export. Hit **Reset** before the next browser. Reset asks for a second click.

## Five minutes

Do this in order. After each step, click that row’s button, then type what the sidebar showed into the note (how many tabs, and whether the thing you just opened was there). The live line at the top is the normal/popup window filter only.

1. **Current Space** (about 20 seconds). Stay in the Space you are viewing. Click **Current Space, unpinned tabs**.
2. **Second Space** (about 40 seconds). Switch to a Space that already has a tab you recognise. Do not click its tabs. Click **Second Space, while you are viewing it**. If the first Space’s tabs vanish from the next copy, `chrome.tabs` only has the Space you are viewing.
3. **Little Arc** (about 40 seconds). Open a Little Arc and leave it up. Click **Little Arc**.
4. **Favorite** (about 30 seconds). Look at a pinned favorite that is not an open tab. Click **Pinned favorite that is not an open tab**.
5. **Split** (about 40 seconds). Split the current tab so both panes are open. Click **Split view, the other pane**.
6. **Slept** (about 40 seconds). If Arc has a sleep or archive action, use it on a tab you are not looking at, then click **Slept, archived, or discarded tab**. If you cannot find that control, click **Discard a background tab** instead. That calls `chrome.tabs.discard` and saves this row. The note should say which one you did.
7. **active:false** (about 30 seconds). Click **tabs.update active:false**. It picks an inactive tab, preferably in a window that is not focused, and sets `{ active: false }` only. Answer **Space stayed** or **Space switched**.
8. **Background open** (about 40 seconds). Click **Open example.com in the background**. Answer whether the Space switched. Answering closes example.com.

Click **Copy markdown** and paste it on the AGE-618 card under the matching browser. The paste has origins, not titles or paths. Read it before it goes into Linear. **Save JSON** is the same record if you want to attach the file. Then **Reset**, change the browser name, and repeat on the browser you are moving to after Arc.

## How to read an empty cell

Until those pastes land, the card’s table stays `unmeasured`. The working rule, including inside the extension’s decision line:

> Background navigate stays limited to the visible window.

Tab tools must not say they see every tab. The description to ship is:

> Tabs the browser exposes through chrome.tabs in the windows it returns. Other Arc Spaces, Little Arc, pinned favorites, split-view partners, and slept tabs may be missing. Incognito is skipped. This is not every open tab.

`chrome.windows.getAll` without `windowTypes` returns only `normal` and `popup`. The extension also asks for `panel`, `app`, and `devtools`. A Little Arc or split pane that shows up only in that second query is listed as an extra type.

## Checks

```bash
node --test spikes/age-618-chrome-tabs/snapshot.test.js
node --check spikes/age-618-chrome-tabs/popup.js
node --check spikes/age-618-chrome-tabs/sw.js
```
