# Live verification — capture-completion disambiguation (goal_374d1363)

Environment: DSH 0.2.2-rc.5 restarted 2026-11-26 ~22:25 local with
`--remote-debugging-port=9222`; window `8BBA3A450218ED8EB2D26C185D20EA42`;
plugin armed from this repo (applied candidate of task `tsk_d997688b`,
attempt `run_94f7489071864181a9c246fcf968e456`, 118 unit tests).
Sessions: A = `session-0c81b1b0-…` ("Read workspace browser pane snapshot"),
B = `session-f59d9ccd-…` ("Open example.com in browser"), both deploy-gms,
same window. Prompts sent via composer; results read from session transcripts
(`session.v4.jsonl.zstd`); view switches via sidebar row click confirmed by
`localStorage['dsh.sessions.current']`.

## Matrix

1. A displayed (restore screen). `browser_open https://example.com` →
   restore-click spawned A's OWN pane `1A6C39F680F672C80AA45177A35EF3C4`;
   cookies restored: restored, persisted 99. Marker `PANE-A-MARKER` injected
   into that webview via CDP (test setup only).
2. Switched to B (restore screen, same stale URL). `browser_open
   https://example.com` (IDENTICAL url) → own pane
   `9BCBC11F0F9D3B925093CB9800CB0248`; cookies already-restored, persisted 99.
   Marker `PANE-B-MARKER` injected there. Two webviews, identical URL — the
   ambiguous case.
3. B displayed: `browser_snapshot` → PANE-B-MARKER only (HAS-A false).
   `browser_screenshot` → succeeded;
   `~/.dsh/browser-state/shots/shot-1795703254495.png` visually shows
   PANE-B-MARKER (owner read the image).
4. Switched back to A (the direction that FAILED with the rAF probe, see
   live-raf-inversion.md): `browser_snapshot` → PANE-A-MARKER only;
   `browser_screenshot` → succeeded;
   `shots/shot-1795703315847.png` visually shows PANE-A-MARKER.
5. Switched to B a third time: `browser_snapshot` → PANE-B-MARKER only
   (HAS-A false). Selection stable across repeated switches.
6. Zero-producer attempt: `Page.setWebLifecycleState frozen` on displayed B
   did NOT stop capture completion (probe still captured B, snapshot correct)
   — freeze is not a zero-producer state. Cmd+H via CDP key events did not
   hide the app; `osascript` System Events minimize/hide is blocked by macOS
   accessibility permission (-1719); this Electron build lacks
   `Browser.getWindowForTarget` (-32601), so CDP minimize is unavailable.
   The zero-producer ('no-capture') and multiple-producer ('ambiguous') error
   paths are therefore UNIT-verified only (tests/windows.test.js zero/multiple
   completer cases; tests/pane.test.js plugin-level exact message +
   doesNotMatch(/call browser_open/)); live demonstration NOT RUN, blocked by
   OS/build access, not by the plugin. Window unfrozen/active left clean.

## Result

Criteria 1–2 (mechanics + error paths): 118/118 unit tests, verify-capture.json.
Criterion 3 (live identical-URL matrix, both switch directions + repeat):
PASS, steps 1–5, marker-checked snapshots AND screenshots.
Criterion 4 (docs): review-capture.md + docs-check.md.

Leftover live state: two example.com panes with markers, B displayed; DSH
running with CDP (not frontmost — Qoder holds focus); user's gms cookie file
untouched by this matrix (persisted 99 both calls, no new login).