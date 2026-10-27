# AGE-617: upstream watchlist

[AGE-617](https://linear.app/agentdesk/issue/AGE-617). Nothing to build.
Check monthly, and when Chrome stable ships a major version. Update
[AGE-584](https://linear.app/agentdesk/issue/AGE-584) and
[AGE-614](https://linear.app/agentdesk/issue/AGE-614) when a trigger below
fires. Close the card only when Ted says the watch is over, or when both
Chrome-stable triggers have shipped and those cards are updated.

Baseline for this note: 2026-10-27. The
[Oct 23 findings](https://linear.app/agentdesk/document/findings-using-teds-browser-without-the-debugging-banner-oct-23-2026-f49d757c2c4d)
still match what was re-read for this pass.

A change that shrinks the banner is not a reason to hide it. The banner
policy in [SECURITY.md](../../SECURITY.md) stays either way.

## Checklist

| # | Watch | Where to look | Baseline 2026-10-27 | Trigger to update the cards |
| --- | --- | --- | --- | --- |
| 1 | W3C WebExtensions #898, synthesize a user gesture | [w3c/webextensions#898](https://github.com/w3c/webextensions/issues/898) | Open. Labels: supportive on Chrome, Safari, and Firefox; `needs-proposal`; topics user activation and scripting. Last issue activity 2026-05-06. No spec text. | A merged proposal, or a Chrome status entry that ships in stable. Real-gesture actions can then leave the debugger path. AGE-614 becomes a leftover for whatever the API still cannot do. |
| 2 | Chromium active-tab-only debugger banner | Commit [`fdf86685`](https://chromium.googlesource.com/chromium/src/+/fdf86685277f317920689d82b3fc8087e5d80448) (2026-09-16, bug 512837934). Feature name in that commit: `MigratedExtensionDevTools`. | Global infobars, including this banner, show only on the active tab of each window when the feature is on. The commit updates tests for both feature states. This pass did not prove the default in Chrome stable. | Default-on in Chrome stable. Confirm on a stable build: attach briefly, see whether a background tab still shows the bar. Then update AGE-614. The bar still shows on the active tab of each window, Cancel still has to stop the attach, and the banner is still not something we hide. |
| 3 | Gentler warning in the post-Arc browser | Helium 0.16.3 release notes, cited from the findings. Related: [AGE-618](https://linear.app/agentdesk/issue/AGE-618). | Helium shows a small pill instead of a full bar. Still visible. Not re-checked against a newer Helium release in this pass. | Ted's next browser is chosen. Re-read that browser's warning: it stays visible, and dismissing it still detaches. Update AGE-614's wording if the control is a pill rather than a bar. |

## How to record a check

Add a row under the log. One line per check is enough. Do not paste page
contents.

```
| Date | Chrome stable | #898 | MigratedExtensionDevTools | Other browser | Cards updated |
| 2026-10-27 | not measured | open, needs-proposal, last touch 2026-05-06 | flag exists, stable default not measured | Helium 0.16.3 pill, from the Oct 23 notes | none |
```

| Date | Chrome stable | #898 | MigratedExtensionDevTools | Other browser | Cards updated |
| --- | --- | --- | --- | --- | --- |
| 2026-10-27 | not measured | open, needs-proposal, last touch 2026-05-06 | flag exists, stable default not measured | Helium 0.16.3 pill, from the Oct 23 notes | none |

On a machine with Chrome: version from `chrome://version`, flag state from
`chrome://flags` (search the feature name), and one background-tab look at
the banner while DevTools capture is attached. Write the version number
into the log. Leave the cell `not measured` when that look did not happen.

## Done

Either both of triggers 1 and 2 have shipped in Chrome stable and AGE-584
plus AGE-614 describe the new behavior, or Ted closes the watch. Trigger 3
updates copy when a browser is chosen. It does not by itself close the card.
