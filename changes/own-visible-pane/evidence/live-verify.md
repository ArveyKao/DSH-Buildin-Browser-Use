# Live verification — own-visible-pane model (goal_f8e1c791)

Date: 2026-11-26 (local 20:19–20:39). DSH 0.2.2-rc.5 relaunched with
`--remote-debugging-port=9222` after commits 9c8442c (visible-bar selection,
screenshot timeout) and de5229b (restore-screen handling). Results read from
the sessions' own event logs (tool/call + tool/result), not agent prose.

## Pre-fix evidence (why the model changed)

- Window CCF5CA3E…: two address bars — visible (435.5px) stale
  `https://example.org/` on a "Previously opened / Restore page" screen with
  NO own webview; hidden (0px) `https://example.com/` on another view's
  webview 9E4BEBD5. `browser_open https://example.com` from the restore view
  Page.navigated the HIDDEN webview (coincidental stale-URL match); follow-up
  snapshot/screenshot failed "no browser pane is visible".
- Typing into the restore bar + Enter navigated the other view's webview
  without attaching; trusted-clicking "Restore page" spawned the view's OWN
  webview CAC068CA. After that, snapshot + screenshot worked on it.
- Earlier same window: `Page.captureScreenshot` on a hidden webview hung the
  session turn indefinitely; it completed the instant the owning view became
  visible (shot-1795694369208.png).

## Post-fix live matrix (window B5F7F023…, fresh process)

1. **Restore screen fail-fast.** 0c81b1b0 (gms) displayed with its restore
   screen: `browser_snapshot` → "no browser pane is visible in this session's
   view; call browser_open with an HTTP(S) url first". No hidden pane driven.
2. **Restore-screen open spawns OWN pane.** Same session
   `browser_open https://example.com` → "Pane BE742417…
   {"url":"https://example.com/"} | cookies restored: restored, persisted: 99".
   Shell then: one visible bar example.com, restore affordance gone.
3. **Second restore view.** Switched to f59d9ccd (gms, restore screen
   example.org): `browser_open https://example.org` → own new webview
   3E7BE7A1. Two webviews coexist (BE742417 example.com hidden,
   3E7BE7A1 example.org visible).
4. **Cross-workspace own pane.** Switched to 48b46d85 (deploy-yl-web):
   `browser_open https://example.net` → own new webview 4CE896DF;
   `browser_snapshot` read example.net. THREE webviews coexist across two
   workspaces; none driven by the wrong session.
5. **Switch-back reads own pane.** Back to 0c81b1b0: `browser_snapshot` read
   example.com (NOT example.net/org); `browser_screenshot` saved
   shot-1795696720849.png. Earlier live-view pair also screenshotted their
   own panes: shot-1795695803638.png (f59d9ccd, example.org),
   shot-1795695844356.png (0c81b1b0, example.com) — both valid 1151×1488 PNGs.

## Cookie isolation (counts/mtimes only)

- `70478d1d058c04aa.json` (deploy-gms): 99 cookies, 12:38:40Z — gms calls.
- `9c9ed64636ec0e60.json` (deploy-yl-web): 62 cookies, 12:38:06Z — yl-web call.
- Other workspace files unchanged (2026-11-25 mtimes). No cross-writes.

## Screenshot timeout

Unit-tested (`browser_screenshot times out with a clear error when capture
never resolves`, 95/95 suite). With visible-bar selection the chosen pane is
the visible one, so the hidden-pane hang is structurally avoided; the 15s
race remains as the mid-call-switch guard. Not forced live (would require
switching views during an in-flight capture).

## Leftover state

Three test panes (example.com / example.org / example.net) left open in their
session views; the user's SSO cookies persist in the gms file and the portal
is restorable from its view. Verification turns appended to the four
sessions' histories (unavoidable for live tool verification).