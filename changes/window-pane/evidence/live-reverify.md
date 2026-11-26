# Live re-verification — window-pane model (goal_256ed8e4)

Date: 2026-11-26 (local 17:54–17:57). DSH 0.2.2-rc.5 relaunched with
`--remote-debugging-port=9222` after commits 06af84f (window-pane selection)
and c053510 (visible address-bar selection). One window, page target
DE39444BDD93C033100D9686A9C49043. All prompts sent through the DSH composer
over CDP; results read from the sessions' own event logs (tool/call +
tool/result), not from agent prose.

## Scenario replay (the user's reported dead end)

1. **gms opens the pane.** Window switched to session-f59d9ccd (deploy-gms,
   "Open example.com in browser"). Prompt: call `browser_open` with
   https://example.com.
   Result: `Pane BCCAC977A4A34E9AE0ACBB91F1149AC2
   {"url":"https://example.com/","title":"Example Domain"} | cookies
   restored: restored, persisted: 64`.
   (Before c053510 this same call failed with "the window did not reveal a
   browser pane address bar" — two pane UIs mounted, hidden input first.)

2. **yl-web drives the gms-opened pane.** Window switched to
   session-48b46d85 (deploy-yl-web, "Open Alibaba Cloud SSO portal") — the
   exact session that previously got "refusing to cross workspaces" on every
   call. Prompt: `browser_snapshot`, no arguments.
   Result: `{"url":"https://example.com/","title":"Example Domain",...}` —
   the same pane BCCAC977, read successfully.

3. **Switch back to gms.** Window switched back to session-f59d9ccd — the
   session that previously got "no open window shows a session of this
   workspace" after the handover. Prompt: `browser_snapshot`.
   Result: same example.com pane content. No dead end.

4. **User's first session.** Window switched to session-0c81b1b0 (deploy-gms,
   "Read workspace browser pane snapshot"). Prompt: `browser_snapshot`.
   Result: same example.com pane content; CDP list confirms webview
   BCCAC977 parented by the window page DE39444B.

## Cookie isolation during handover

File counts and mtimes only (values never read into evidence):

- `70478d1d058c04aa.json` (deploy-gms): 64 cookies, written 09:54:18Z by the
  gms `browser_open` call.
- `9c9ed64636ec0e60.json` (deploy-yl-web): 64 cookies, written 09:54:51Z by
  the yl-web `browser_snapshot` call — a NEW file keyed by the calling
  workspace; the gms file was not touched by that call.
- Other workspace files unchanged (mtimes 2026-11-25).

Restore injected the calling workspace's own file on its first call
(`restored` for gms); the shared jar then snapshots to whichever workspace
calls, matching the documented model.

## Not displayed → clear error

Covered by unit tests (`chooseCallerPane fails clearly when the caller is
displayed in no window`); a live call from a non-displayed session is not
reachable through the composer without displaying it, so no live receipt for
that path.

## Leftover state

Pane left at https://example.com/ (test page). The user's SSO portal session
cookies persist in the gms file; DSH's pane UI offers "Restore page" for the
portal URL. A few verification turns were appended to the four sessions'
histories (unavoidable for live tool verification).