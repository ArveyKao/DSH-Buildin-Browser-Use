# Live smoke receipt — 2026-11-26, DSH Desktop 0.2.2-rc.5, CDP 127.0.0.1:9222

Plugin: @local/dsh-workspace-browser linked from /Users/mt/plugins/build-in-browser-use,
fix commit abdf078 (pane-spawn URL pass-through). Driven by the owner over CDP; the DSH
agent (deepseek-flash via moonton provider, key resolved by host credential broker)
executed the tool calls in real sessions.

## 1. Pane spawn (regression fix verified)

- Fresh DSH start, no pane. Session A = session-2a80ad35-ea18-49f4-b53f-3007b519555c
  (workspace deploy-gms, window target 21C96885B1BAD010FEC4C8C4A2589D9A).
- Prompt: browser_open https://example.com → webview target spawned:
  `webview | Example Domain | 52DA7586A07E2C6F7BE4167B27A7BE63 | https://example.com/`
- Agent follow-up browser_snapshot confirmed url https://example.com/, title "Example Domain".
- Pre-fix behavior (same day, commit 672abe8): "the browser pane opened but no page target
  appeared" — root cause: URL arg dropped from openPaneInWindow; DSH spawns the webview
  only after an HTTP(S) URL loads in the address bar (about:blank rejected, verified live).

## 2. Two sessions in one workspace share one pane

- Session B = session-0c81b1b0-3c91-4a2c-8bb0-99f281cde11d, created via New session in the
  same window/workspace (deploy-gms).
- Prompt: browser_snapshot (no arguments) → agent reported verbatim:
  URL https://example.com/, Title "Example Domain" — the same pane session A opened.
  Completed in 2s, 1 turn 2 steps.

## 3. Cookie persistence across DSH restart

- Session B: browser_evaluate `document.cookie = "dsh_smoke_test=persist-check-1; path=/; max-age=86400"`
  then `document.cookie` → `dsh_smoke_test=persist-check-1`.
- Plugin post-call snapshot wrote ~/.dsh/browser-state/70478d1d058c04aa.json (mode 0600,
  357 bytes, 2026-11-26 16:46): {"savedAt":…,"cookies":[{name:"dsh_smoke_test",
  value:"persist-check-1",domain:"example.com",path:"/",expires:1795769176.06617}]}.
- DSH quit (all processes exited, port free) and relaunched with --remote-debugging-port=9222.
  Pane gone (in-memory partition, as designed). Window target 8AA99758AFD895229FA8FD89C125E49D.
- First browser call in the restarted app, session B:
  browser_open https://example.com → verbatim:
  `Pane 92BA171D274F4B10553C419C5D6C4614 {"url":"https://example.com/","title":"Example Domain"} | cookies restored: restored, persisted: 1`
  browser_evaluate `document.cookie` → verbatim: `dsh_smoke_test=persist-check-1`
- Restore happened on the first call (restoreCookiesOnce), before the tool callback;
  the re-snapshot persisted 1 cookie.

## Notes

- Real SSO/scan login is excluded by design (user signs in themselves); persistence was
  proven with a test cookie on example.com (IANA reserved domain — fine for a mechanism
  check, not a real-site endorsement).
- The first browser_open prompt landed in the user's existing session-2a80ad35 because the
  restarted window restored it; two harmless turns were added there. Session B is a fresh
  smoke session.
- Failure paths exercised earlier the same day: missing pane + no URL now fails fast with
  "no browser pane is open in this workspace; call browser_open with an HTTP(S) url first"
  (unit-tested); missing CDP endpoint error and cross-workspace refusal covered by 49 unit tests.