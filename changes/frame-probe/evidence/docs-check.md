# Docs check — capture-completion disambiguation (goal_374d1363 criterion 4)

Owner read of README.md and docs/DETAIL.md in the applied candidate (main
checkout after `dispatch apply tsk_d997688b`), cross-checked by the
independent review (review-capture.md, criterion 4 PASS):

- Both describe same-URL disambiguation by CAPTURE COMPLETION: a tiny 1×1
  `Page.captureScreenshot` raced against a 2500ms bound, run in parallel only
  when 2+ webviews match the visible bar URL; the sole completing candidate
  is driven; single match taken unprobed.
- Zero completers (DSH window not front/active) or several → clear error
  asking to bring the session's DSH window to the front and retry; no
  first-match guess; restore screens exempt and never probed.
- No rAF/animation-frame selection claims remain; the single rAF mention is
  the code comment explaining why rAF is NOT used (live-proven unreliable
  across view switches, live-raf-inversion.md).
- Unchanged and accurate: per-session-view pane model, visible-bar selection,
  restore-screen open flow, explicit targetId refusal, 15s screenshot guard,
  per-CALLING-workspace cookie files, pane-spawn rule, arming instructions.