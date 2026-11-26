# Docs check — window-pane model (goal_256ed8e4 criterion 4)

Owner read of README.md and docs/DETAIL.md at commits 06af84f / c053510:

- Both state the pane belongs to the WINDOW; any displayed Session drives it
  regardless of opening workspace; switching sessions hands the pane over.
- Selection order documented: stored session id per window
  (`localStorage['dsh.sessions.current']`), title fallback only when no window
  yields an id; not-displayed error string matches lib/scope.js verbatim.
- Pane-spawn rule (first call must be browser_open/browser_navigate WITH an
  HTTP(S) URL) and the fail-fast string match index.js.
- Explicit targetId must be the caller window's pane; refusal string matches.
- Cookie section: jar shared by whoever drives the pane; snapshot files keyed
  by CALLING workspace, never merged, 0600, restore once per workspace per
  process — matches lib/state.js and the live handover receipt
  (live-reverify.md: gms file untouched by the yl-web call).

No stale workspace-binding or "refusing to cross workspaces" language remains
(grep over README.md and docs/DETAIL.md).