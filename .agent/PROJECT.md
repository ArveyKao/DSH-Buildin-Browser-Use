# build-in-browser-use

Keep stable facts needed to run, verify, and deliver this project. Link maintained sources. Existing accepted scope/authority and assigned roles are reused. Unknown production details do not block independent authorized local work.

## Next useful delivery

- User-visible outcome / north star: a DSH Desktop plugin bundle that, once armed, gives the agent tools to drive DSH's built-in browser; each Session drives the pane visible in its own view (DSH keeps one pane per session view), and all Sessions in one workspace share cookies/cache.
- Accepted problem, hypothesis and success metric: the built-in browser's `WebContentsView` is unreachable in-process (main-process owned, `webviewTag:false`, no Host→Client RPC), so a native Host cordis plugin + CDP (`http://127.0.0.1:9222`) is the working route. Success: two sessions in one workspace demonstrably share one pane and its login state; cookies survive a DSH restart.
- Non-goals and boundaries: no HTTP-cache persistence across restarts (in-memory partition; cookies only); no cross-workspace sharing; no automated SSO/scan login; no modification of the installed DSH app; MCP-stdio approach dropped (cannot identify the calling Session).
- Target kind, exact environment and surface: local plugin artifact (Node ESM cordis bundle) loaded by DSH Desktop 0.2.2-rc.5 on this Mac; exercised through the live DSH app launched with `--remote-debugging-port=9222` ("DSH with CDP" launcher).
- Address, device or artifact location: repo `/Users/mt/plugins/build-in-browser-use`; armed via DSH bundle patch (`dsh.bundle.patch` → `cordis.patch.yml`); cookie state at `~/.dsh/browser-state/<workspace-hash>.json`.
- Final demo (command/URL, inputs, expected output): with DSH launched via the CDP launcher and the plugin armed — Session A `browser_open` a URL in its own view; Session B (same workspace) opens/reads its OWN pane; screenshots show what each user sees; after DSH restart, restore-screen views re-spawn their own pane on open and cookies persist per calling workspace. Verified live in `changes/own-visible-pane/evidence/live-verify.md`.
- Applicable evidence / required review: `node --check` + `node --test` unit tests for scope/state logic; live CDP smoke receipts against the running app; cross-family review of the consolidated candidate.
- Current next action or waiting dependency: goal `goal_374d1363` in flight — waiting on rework task `tsk_d997688b` (capture-completion probe), then live identical-URL verification in both switch directions.

## Existing commands

| Purpose | Command or existing source |
| --- | --- |
| Dependency setup and run | None (zero-dependency Node ESM; Node >= 22). Arm by linking the bundle into DSH per `cordis.patch.yml` |
| Relevant automated checks | `node --test` (auto-discovery; the `tests/` dir-arg form fails on this Node build); `node --check index.js` + `node --check` per `lib/*.js` |
| Demo / E2E including meaningful failure/recovery | Live CDP smoke: `curl http://127.0.0.1:9222/json/version` then tool calls from two sessions in one workspace; missing-endpoint failure path must report, not act on wrong page |
| Build / package | Not applicable (plain JS bundle, no build step) |
| Deploy / smoke / recovery | Arm/disarm via DSH bundle patch; recovery = remove the patch entry |
| Background health/log query | Not applicable — no project-owned background runtime |
| Server/API contract, durable effects, access and recovery | CDP endpoint is loopback-only; cookie files per workspace under `~/.dsh/browser-state/`, never mixed across workspaces |
| Performance / regression budget | Not triggered |

## Now

- Delivered: goal `goal_0171c3c9` (same-URL capture-completion disambiguation; superseded goals `goal_25bacc7c` rAF design and `goal_374d1363` pre-refinement wording). Commits `654a770` (capture probe) + poll-skip commit; 121 tests. Live matrix passed BOTH switch directions + repeat, marker-checked snapshots and screenshots (`changes/frame-probe/evidence/live-verify.md`). rAF design live-invalidated (`live-raf-inversion.md`), archived diff `raf-candidate.diff`. Zero-producer live demo NOT RUN (OS accessibility / Browser-domain blocked); unit-covered. Receipts: verify-capture.json, review-capture.md, verify-poll-skip.json, live-verify.md, docs-check.md.
- Delivered: goal `goal_f8e1c791` (own-visible-pane model), commits `9c8442c` + `de5229b` + record `74235eb`, pushed; receipts `changes/own-visible-pane/evidence/`.
- Delivered: goal `goal_256ed8e4` (window-pane model), receipts `changes/window-pane/evidence/`, pushed through `5e4b1c8`.
- Delivered earlier: goal `goal_3cbefe11` (plugin + smoke + README), pushed through `c80e2fb`.
- Armed: profile links `@local/dsh-workspace-browser` → this repo; DSH running with CDP (window `8BBA3A45…`). Live test state: two same-URL example.com panes with markers, B displayed.
- Known environment limits: dispatch review tasks never leave queued in this orchestrator (independent review via fresh read-only agent context instead); slot worktrees reset to HEAD, so commit applied work before dispatching dependent tasks; osascript System Events writes blocked (no accessibility grant); this Electron build lacks Browser.getWindowForTarget.
- Next: commit receipts + brief, push origin main. No open tasks.

## Target applicability and access

- Execution mode and stable role ownership: owner = Qoder main session (this runtime); implementation via dispatched worker runtimes once the user allows them. Owner does not edit product code.
- Operator applicability: not_applicable — local plugin artifact exercised inside the user-run DSH Desktop app; the project deploys no background service and owns no monitored target. Evidence is command receipts + live CDP smoke.
- Runtime exemption, if this is a CLI/library artifact without a service: applies — plugin bundle loaded by a user-operated desktop app; no project service, credentials, or heartbeat required.
- Access/credential metadata: link existing scope-specific method and credential locations, never values. No access installation is a prerequisite for a service-free local artifact.
- Requested deployment destinations, existing authority and recovery: UNCONFIGURED when applicable. Targets are alternatives; promote only through a requested sequence.
- For live targets, record environment → service → release → source/artifact and observation query, observed_at/expires_at. A report timestamp or file mtime is not freshness.

## Shared contract and context map

- Canonical instructions: `AGENTS.md`; aliases such as CLAUDE.md/GEMINI.md should be relative internal symlinks. Preserve existing instructions and symlinks when refreshing a generated marker.
- Brief: this file. Reference paths in the generated rules resolve from the installed arvey-develop skill directory.
- Shared role definitions: `.agent/roles/` or the project-selected alternative. Pass the relevant role to a delegated worker; do not launch every role.
- Cross-feature contract and owner: UNCONFIGURED when parallel work applies. Workers route changes through affected owners.
- Canonical docs/runbooks: link existing sources; read on demand.
- Evidence: `changes/<id>/evidence/` and linked CI/issue receipts, retained with records.
- Working notes: `.agent/scratch/` (gitignored) or outside the repo; time-boxed and not default context.
- Live state: structured observed_at/expires_at and source; stale/unknown state requires verification before use.

## Actual constraints

Record existing authorized environments/actions, data boundaries, specified resource limits, independent review and recovery controls. Reuse answered decisions and nonblocking defaults; ask only for missing outcome/scope/authority. A blocked external action does not halt independent local work. Do not invent an approval gate to fill this section.

Define API fields, audiences/roles and ownership/tenant boundaries when relevant. Authorized product data is distinct from credentials. Update conflicting project defaults/tests with an authorized scoped change. Host/external access restrictions remain effective.

Prefer existing brokers/short-lived scoped capabilities. Record secret locations as metadata only; preserve scanners/guards and keep values out of records, prompts and evidence. External restrictive storage is the default. A dedicated repo-local secret path needs explicit authorization, ignore/deny-list protection and restricted permissions. Apply relevant secret/tool setup within its authorized scope.

## Delivery and coordination

Use an existing issue/PR for a small fix, or one current delivery.json for sustained work. Reuse accepted alignment, then intent → design → develop → test → deploy/evaluate the selected surface → issues/revise → maintain the agreed window. Choose a visual/options only when they settle ambiguity. Work backwards from the final demo and preserve accepted criteria.

One integration owner writes a shared record for parallel workstreams. Freeze contracts and a clean committed base, configure common-local Git arvey.coordinationRef, create claims serially on its registered authoritative checkout, then create named worktrees. Feature snapshots are read-only board views. Explicit integration actors preserve worker ownership. A lock does not coordinate independent clones. Isolate mutable resources, ports, fixtures and artifacts.

Record source:v2 effective content, independently hashed artifact identity where applicable, and immutable provenance.tested_revision. Keep old receipts unchanged. Reuse evidence only when applicable inputs/configuration/environment/freshness match. Run health, liveness, successful observation and coverage are separate; generated_at never refreshes observations.

Use canonical pre-deploy readiness before target execution, post-deploy for actual target evidence, and complete for final completion. An explicitly post-deploy check needs phase_reason tied to plan.final_demo. Default checks are pre-deploy; default assessment remains post-deploy. Mark actually integrated workstreams terminal before final complete/closeout. A fresh reviewer checks the frozen combined candidate. Synchronize root rules/template explicitly while preserving custom facts and history.

Operational issues require current-cycle deployment/verification/closure. Verify the same diagnostic intent in a fresh comparable post-deployment window; blocked/resume cannot skip lifecycle roles. Default portable handoff carries decisions/defaults, contracts, identities, evidence and stale/unknown facts; the receiver rechecks them. Committed-durability closeout uses canonical complete assessment and terminal authority state. Abandonment is distinct from delivery.

Every wait names a condition and every retry has new information or bounded transient rationale. Stop after accepted outcomes, applicable gates, evidence and required review pass. Report real failures and NOT RUN criteria as incomplete; do not add perpetual work after acceptance.
