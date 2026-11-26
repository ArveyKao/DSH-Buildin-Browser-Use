# DSH-buildin-browser-use

A DSH Desktop (DeepSeek Harness) plugin bundle that, once armed, gives the agent
tools to drive DSH's built-in browser pane over the Chrome DevTools Protocol (CDP).

All Sessions in one workspace read and drive the same pane and share its cookies;
nothing crosses workspaces. Cookies are snapshotted per workspace and restored
after a DSH restart.

## Why CDP

DSH's built-in browser is a main-process `WebContentsView` (`webviewTag: false`,
no Host→Client RPC), unreachable from in-process code. Launching DSH with
`--remote-debugging-port=9222` publishes its web contents as CDP targets, which
the plugin attaches to. The installed app is not modified.

The plugin is a native Host cordis bundle (`index.js` + `lib/`), not an MCP
server: only a Host tool sees the calling Session (`exec.agent.session`) and can
therefore refuse calls from another workspace.

## Sharing model

- **One pane per workspace.** Every Session in a workspace drives the same pane.
  A pane is bound to the workspace that first used it; calls from a different
  workspace are refused rather than served the wrong page.
- **Window → Session mapping.** Each DSH window stores the Session it displays in
  `localStorage['dsh.sessions.current']`. The plugin reads that value per window
  over CDP and picks the pane whose `webview` target is parented by a window of
  the workspace. Window-title matching is only a fallback.
- **Pane spawn rule.** DSH creates the pane's `webview` target only after an
  HTTP(S) URL loads in its address bar. So the first call in a workspace must be
  `browser_open` or `browser_navigate` *with* a URL; every other tool needs an
  already-open pane and fails fast otherwise.
- A pane renders in one window only; other Sessions read and drive it, they do
  not mirror it into their own window.

## Cookie persistence

DSH's browser partition is per workspace and in memory, so logins end at every
restart. After each successful call the plugin snapshots cookies
(`Network.getAllCookies`) to `~/.dsh/browser-state/<workspace-hash>.json`
(mode `0600`) and re-injects them (`Network.setCookies`) on the first call after
a restart. Restore happens once per workspace per process; a failed restore is
retried on the next call. Cookies are never mixed between workspaces.

The HTTP cache stays in memory and does not survive restarts — cookies only.

## Tools

| Tool | Purpose |
|---|---|
| `browser_targets` | List windows, the Session each shows, their panes, and every CDP target |
| `browser_scope_probe` | Same mapping plus the chosen pane, its host window and why it was chosen |
| `browser_open` | Open the workspace browser, optionally loading a URL (the URL is required when no pane exists yet) |
| `browser_attach` | Report the pane workspace-scoped calls use, without navigating |
| `browser_navigate` | Load a URL in the workspace pane; hands an unreachable host to your default browser |
| `browser_open_external` | Open a URL in your own default browser; nothing is automated there |
| `browser_snapshot` | Read URL, title, visible text, links and form fields |
| `browser_click` | Click the first element matching a CSS selector |
| `browser_type` | Set an input/textarea/select value, optionally pressing Enter |
| `browser_evaluate` | Evaluate JavaScript in the page and return its value |
| `browser_screenshot` | Save a PNG under `~/.dsh/browser-state/shots` (or an absolute `filePath`) |

Pane tools default to the calling Session's workspace pane. Where a tool takes
an optional `targetId`, it must name a `webview` pane of this workspace; an
unknown id, a non-pane target, or a pane hosted by another workspace's window is
rejected with an error.

## Arming

1. Link this directory into the DSH desktop profile as
   `@local/dsh-workspace-browser` (for example, a dependency entry in
   `~/.dsh/profiles/desktop/package.json`). Nothing to install — zero npm
   dependencies.
2. The package declares `dsh.bundle.patch` → `cordis.patch.yml`; that patch
   inserts the plugin with id `workspace-browser` and `config.cdpEndpoint`
   (`http://127.0.0.1:9222` by default).
3. Launch DSH through the **"DSH with CDP"** launcher, or directly:

   ```
   "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --remote-debugging-port=9222
   ```

4. Confirm the endpoint with `curl http://127.0.0.1:9222/json/version`; the
   `browser_*` tools then appear.

Disarm by removing the patch entry and restarting DSH. Full steps, selection
order and failure behavior: [docs/DETAIL.md](docs/DETAIL.md).

## Requirements

- DSH Desktop 0.2.2-rc.5 (tested) with its built-in browser, launched with CDP.
- Node.js >= 22 for the check commands. Plain ESM, zero npm dependencies.

## Limits

- Signing in is your job: no SSO or scan-code automation. Sign in once in the
  pane and cookies persist across restarts.
- The CDP port is loopback-only but exposes every web content to local
  processes — a developer-machine setting, not a shared-host one.
- Concurrent Sessions can act on the same tab; no per-call isolation or locking.
- No HTTP-cache persistence, no cross-workspace sharing, no pane mirroring.
- Pane tools other than `browser_open` / `browser_navigate` need an open pane.

## Development

```
node --check index.js && for f in lib/*.js; do node --check "$f"; done
node --test
```

`node --test` runs the 49 unit tests for scope selection and cookie/workspace
state (no browser, no network).

## License

MIT — see [LICENSE](LICENSE).
