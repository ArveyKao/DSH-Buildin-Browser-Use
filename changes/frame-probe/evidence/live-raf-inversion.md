# Live finding: rAF probe is unreliable after view switches (rework trigger)

Process: DSH restarted 2026-11-26 ~22:05 local, window
`F788F4EDA705C5FF068514F2688305C7`. Candidate: accepted frame-probe task
`tsk_55699b6f` (commit-pending working tree, 108 tests).

## Matrix run

1. Session A (`0c81b1b0`, displayed) `browser_open https://example.com` →
   restore-click spawned own pane `7602543C2F9A859D613FFAEB348759A9`;
   cookies restored 99. Marker `PANE-A-MARKER` injected there via CDP.
2. Switched sidebar to B (`f59d9ccd`); `browser_open https://example.com`
   (IDENTICAL url) → restore-click spawned own pane
   `0829EE3EDB856775E4E6B36F4FD81484`, navigated to example.com.
   Marker `PANE-B-MARKER` injected there. Two webviews, same URL.
3. B displayed: `browser_snapshot` → contains PANE-B-MARKER only (correct).
   rAF probe: B fired, A timed out (matched display).
4. B displayed: `browser_screenshot` → 15s timeout error. Direct CDP capture
   on B also hung (20s), even after `open -a`; later captures on B succeeded
   with and without marker → transient window-activation state, guard worked
   as designed (clear error, no hang). Retry via plugin succeeded; saved
   `~/.dsh/browser-state/shots/shot-1795702370974.png` shows PANE-B-MARKER.
5. Switched sidebar back to A (localStorage bridge confirms A displayed).
   A `browser_snapshot` → contains **PANE-B-MARKER**, NOT PANE-A: WRONG PANE.
   Shell screenshot `/tmp/window-after-switchback.png` shows the pane region
   rendering **PANE-A-MARKER** (user sees A).
   rAF probe now: A (displayed) `raf-timeout`, B (hidden) `raf-fired` —
   INVERTED vs step 3, >60s after the switch (steady state, not settle lag).
6. Capture-completion probe (parallel, 3s CDP-level cap):
   A (displayed) `captured`; B (hidden) `TIMEOUT` — matches what the user sees.

## Conclusion

- rAF firing does NOT track the displayed view across view switches in this
  DSH build (fired on the hidden pane in step 5; matched in step 3 and in the
  previous process's steady state). It must not be the selection signal.
- `Page.captureScreenshot` completion DOES track the rendered pane in every
  observation (hidden panes never complete; displayed completes once the
  window is active). Use a bounded capture-completion probe instead.
- The 15s screenshot guard and the clear-error-on-zero-producers behavior
  remain correct and were exercised live (step 4).

Rework: replace FRAME_PROBE_SCRIPT/rAF with a bounded capture probe
(~2.5s cap, 1×1 clip, parallel, sessions closed, pending rejected on close).