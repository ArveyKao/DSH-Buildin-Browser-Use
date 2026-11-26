# Independent review — frame-probe disambiguation (goal_25bacc7c)

Reviewer: separate read-only agent context (not the implementer). The
dispatch review task `tsk_9b328500` never left `queued` (dispatcher created no
attempt in ~22 min; no capacity holder found), so it was cancelled and the
review ran as an independent agent instead.

Candidate: uncommitted working tree vs HEAD `74235eb` (task
`tsk_55699b6fd57d42bcad1b11269a2b0c09`, attempt `run_e8c8ef1f01a14755b6d5dd355ea660e9`).
Reviewer ran `node --check` (clean) and `node --test` (108/108 pass) and read
every changed file in full. `lib/state.js`, `lib/cdp.js`, `lib/ops.js` untouched.

## Verdict: ACCEPT — nothing blocking

Verified against criteria:
- `selectPane` (lib/windows.js): restoring → no pane/no probe; 0 candidates →
  no pane; 1 candidate → no probe; `Promise.all` index alignment correct;
  exactly-one-producer wins; 0 → 'no-frames', ≥2 → 'ambiguous'.
- `FRAME_PROBE_SCRIPT`: settled flag + clearTimeout; late rAF no-op;
  `evaluate` awaitPromise/returnByValue propagates the string.
  `probeFrameProduction` closes the session in `finally` on every path.
- `paneError` guard in `withPane` (index.js:203) precedes `resolvePane` and the
  open path → covers ALL pane tools incl. browser_open/navigate and targetId;
  reachable via session-id AND title-fallback paths. No guessed-pane path.
- Tests honest: closure ledgers, error-kind/message asserts, plugin-level
  `doesNotMatch(/call browser_open/)` (tests/pane.test.js:519).
- Docs match code (600ms, error wording, probe-only-when-ambiguous, restoring
  exempt, old first-match limitation fully replaced).

## Minor findings (non-blocking, recorded as follow-ups)

1. lib/windows.js:236 — probing runs for every window in `readWindows`, not
   only the caller's (caller unknown at that layer). A non-caller ambiguous
   window adds ~600ms; probe script is inert (rAF timing only), reads no page
   data, sessions closed. No leakage.
2. lib/windows.js:156 — probe evaluate has no CDP-side timeout; a frozen
   renderer could hang readWindows. Same exposure as existing readWindowShell.
3. Test gaps: no probe-closure test for evaluate-throws-after-connect; no
   title-fallback paneErrorMessage test. Code handles both.
4. Nit: `?? 'the same address'` (lib/windows.js:166) is dead (multi-candidate
   implies non-null URL).

Owner spot-checks confirmed: tests/pane.test.js:519 doesNotMatch assert;
index.js:203-206 guard placement; verify receipt 108/108.