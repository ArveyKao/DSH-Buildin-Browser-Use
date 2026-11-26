# Independent review — capture-completion probe rework (goal_374d1363)

Reviewer: separate read-only agent context (not the implementer). Candidate:
worktree `slot-1` (74235eb + uncommitted), task
`tsk_d997688b92af4a66bc4d45d9dce0cc13`, attempt `run_94f7489071864181a9c246fcf968e456`.
Checks run in the worktree: node --check clean; node --test 118/118.
Protected paths (lib/cdp.js, lib/ops.js, lib/state.js, .agent/, AGENTS.md,
.gitignore, changes/) zero diff.

## Verdict: ACCEPT — nothing blocking

- Probe mechanics: `CAPTURE_PROBE_TIMEOUT_MS = 2500` (lib/windows.js:29);
  `probeCaptureCompletion` (147–168) 1×1 PNG clip, injectable sleep race,
  `.catch(()=>false)` prevents unhandled rejection when close() rejects the
  abandoned send; session closed in finally incl. connect-throw; image data
  discarded. `selectPane` (182–194): 0/1 match unprobed; parallel Promise.all
  index-aligned; 0 completers → 'no-capture', 2+ → 'ambiguous', human messages;
  no first-match fallback; restoring bypasses probe.
- Error surfacing: paneError/message carried through chooseCallerPane
  session-id AND title-fallback paths; index.js:201–204 guard before
  resolvePane and open path → all pane tools incl. targetId; never the
  browser_open hint; no-pane fail-fast, restore handling, spawned-tracking
  byte-identical to HEAD.
- Tests genuine: closure on success/cap/send-throw/send-reject; parallelism
  proven by a both-connected gate that would deadlock sequential probing;
  alignment proven with the SECOND candidate completing; zero/multiple kinds
  + messages; single-match and restoring zero probe connects; plugin-level
  exact message + doesNotMatch(/call browser_open/) + zero openCalls.
- Docs: capture-completion, 2500ms, 1×1 clip, parallel, ambiguous-only cost,
  front-window requirement; only rAF mention is the comment explaining why it
  is NOT used. Restore/cookies/15s-guard text accurate.

## Non-blocking findings

1. minor — index.js:147 open-path polling (25×) pays the ~2.5s probe per poll
   when 2+ same-URL panes exist, though the spawned check ignores `pane`.
   Latency only.
2. nit — lib/windows.js:158 sleep timer not cancelled on early completion
   (keeps loop alive ≤2.5s; harmless in host).
3. nit — README line 10 overlong wrap.

Supersedes: review.md (rAF candidate ACCEPT) — invalidated by
live-raf-inversion.md; the rAF candidate diff is archived at
raf-candidate.diff and its main-tree edits were reset before applying this
candidate.