# Docs check — own-visible-pane model (goal_f8e1c791 criterion 4)

Owner read of README.md and docs/DETAIL.md at commits 9c8442c / de5229b:

- Both state DSH keeps one pane per session view; the tools drive the pane
  VISIBLE in the caller's view, identified by matching the window's visible
  address-bar URL against its webview targets; no first-webview fallback;
  other views' hidden webviews are never driven.
- Restore screen documented: stale bar names no live pane (pane null even on
  a coincidental URL match); browser_open/browser_navigate trusted-click
  "Restore page" first, then load the URL through the live bar; a restored
  view spawns its pane on that click.
- Same-URL limitation documented: two views showing the identical URL are
  indistinguishable; first match used.
- Explicit targetId must be the caller's own pane; screenshot 15s timeout
  with the switch-to-session error; pane-spawn rule kept.
- Cookies: shared jar, files per CALLING workspace, restore once per
  workspace per process — matches lib/state.js (unchanged) and the live
  cookie-isolation receipt.
- No stale "one pane per window" / handover / workspace-binding claims
  remain (grep: the only "handover" hits are explicit negations).