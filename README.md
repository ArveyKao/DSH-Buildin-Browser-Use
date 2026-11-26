# DSH-buildin-browser-use

A DSH Desktop (DeepSeek Harness) plugin bundle that, once armed, gives the agent
tools to drive DSH's built-in browser pane over the Chrome DevTools Protocol (CDP).

DSH keeps one browser pane **per session view**. The plugin drives the pane that
is VISIBLE in the calling Session's own view: it matches the window's visible
address-bar URL against that window's webview targets, and when several show the
same URL only the one whose frame capture completes is chosen (hidden panes never
complete). `browser_open` / `browser_navigate` load the URL through that visible
bar. Other sessions' webviews (alive but hidden) are never driven. A view restored from a previous
process shows a "Restore page" screen with a stale bar and no pane of its own;
the plugin restores it before loading. Cookie snapshot files stay per workspace.

## Why CDP

DSH's built-in browser is a main-process `WebContentsView` (`webviewTag: false`,
no Host→Client RPC), unreachable from in-process code. Launching DSH with
`--remote-debugging-port=9222` publishes its web contents as CDP targets, which
the plugin attaches to. The installed app is not modified.

The plugin is a native Host cordis bundle (`index.js` + `lib/`), not an MCP
server: only a Host tool sees the calling Session (`exec.agent.session`) and can
therefore map it to the pane visible in its own view.

## Per-session-view pane model

- **Every view has its own pane.** DSH mounts a pane UI per session view; the
  view the user is looking at shows its address bar at full width, hidden views'
  bars report `width` 0. All pane webviews parent to the same window page target.
- **Selection is by the visible address bar.** Each window's shell page stores
  the displayed Session id in `localStorage['dsh.sessions.current']`; the plugin
  reads that (one evaluate per window) together with the visible address bar's
  value and whether a "Restore page" affordance is mounted. The caller's window
  decides which view belongs to the caller, and the bar URL is normalized and
  matched against every webview in that window. There is no first-webview
  fallback: an unmatched bar means no visible pane yet. When 2+ webviews match,
  each is probed in parallel with a 1×1 `Page.captureScreenshot` bounded at
  ~2.5s, and only the one whose capture completes is the rendered pane.
  Window-title matching is only a fallback when no window yields a session id.
- **Restore screens report no pane.** A view whose pane was loaded in a previous
  DSH process reopens on a "Previously opened / <title> / Restore page" screen:
  its address bar is mounted and pre-filled with the OLD URL, but the view has
  no webview target yet. That stale bar identifies no live pane of this view, so
  it is never matched to another view's webview — not even when both URLs are
  identical. `browser_open` / `browser_navigate` trusted-click "Restore page"
  first, wait for this view's own pane, then load the requested URL through the
  now-live bar.
- **Switching sessions switches the visible pane.** There is no handover of one
  shared page: the newly displayed view's own bar and webview become the target,
  and the previous view's webview is left alone.
- **Pane spawn rule.** DSH creates a pane's `webview` target only after an
  HTTP(S) URL loads in its address bar (a restored view spawns its pane when
  "Restore page" is clicked). So a view with no pane must first call
  `browser_open` or `browser_navigate` *with* a URL, which types into the visible
  bar and spawns the webview; every other tool needs an already-open visible pane
  and fails fast otherwise. After opening, the plugin returns the webview with a
  fresh target id (the visible view's spawned pane, including a restore-spawned
  one), or, when no new target appears, an existing view whose URL the bar
  changed. A hidden view that already showed that URL is never taken.
- **Explicit `targetId` must be the caller's own pane.** An unknown id, a non-pane
  target, or another webview (even in the same window) is refused.
- **Identical URLs are disambiguated by capture completion.** Two or more views
  showing the exact same URL match the bar equally, so each candidate gets a 1×1 PNG
  `Page.captureScreenshot` probe bounded at ~2.5s, run in parallel. A hidden pane
  never completes a capture; the rendered pane does once its DSH window is in
  front/active. Exactly one completer is driven. Zero completers (for example,
  the window is not in front) or several leave the visible pane unidentified and
  the call fails with a clear "bring this session's DSH window to the front and
  retry" message — never a first-match guess. A sole URL match is used unprobed.
  Restore screens are the exception: their stale bar never identifies a live
  pane and is never probed. Open-path polling skips the probe (`probe: false`)
  because it identifies the spawned webview by target events, so the ~2.5s cost
  applies to pane reads and clicks in the ambiguous case, not to every open poll.
- **Not displayed, no pane.** A Session shown in no open window gets a clear
  error: switch to it in a DSH window first.
- **Screenshots are bounded.** `Page.captureScreenshot` never completes on a
  hidden webview — the same property selection relies on — so `browser_screenshot`
  fails after 15s with an explicit "pane may be hidden" error instead of hanging
  the turn.

## Cookie persistence

The browser's cookie jar is in memory and shared by the app (DSH behavior), so
logins end at every restart. After each successful call the plugin snapshots the
jar (`Network.getAllCookies`) to `~/.dsh/browser-state/<workspace-hash>.json`
(mode `0600`) for the **calling** workspace, and re-injects that workspace's
cookies (`Network.setCookies`) on the first call after a restart. Files stay per
workspace and are never merged; each captures the app-wide jar's state at that
workspace's calls. Restore happens once per workspace per process; a failed
restore is retried on the next call.

The HTTP cache stays in memory and does not survive restarts — cookies only.

## Tools

| Tool | Purpose |
|---|---|
| `browser_targets` | List windows, the Session each shows, each window's visible pane URL and webview count, and every CDP target |
| `browser_scope_probe` | Same mapping plus the pane visible in the caller's view and why it was chosen |
| `browser_open` | Open the pane visible in this session's view, optionally loading a URL (the URL is required when no visible pane exists yet); a restore screen is restored first |
| `browser_attach` | Report the pane visible in this session's view, without navigating |
| `browser_navigate` | Load a URL in the visible pane; hands an unreachable host to your default browser |
| `browser_open_external` | Open a URL in your own default browser; nothing is automated there |
| `browser_snapshot` | Read URL, title, visible text, links and form fields |
| `browser_click` | Click the first element matching a CSS selector |
| `browser_type` | Set an input/textarea/select value, optionally pressing Enter |
| `browser_evaluate` | Evaluate JavaScript in the page and return its value |
| `browser_screenshot` | Save a PNG under `~/.dsh/browser-state/shots` (or an absolute `filePath`); times out after 15s if the pane is hidden |

Pane tools default to the pane visible in the calling Session's view. Where a
tool takes an optional `targetId`, it must name that same pane; an unknown id, a
non-pane target, or any other webview is rejected with an error.

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
- Each session drives the pane visible in its own view; other views' webviews are
  never touched. Calls within the same view are not locked against each other.
- Two or more views showing the identical URL are told apart by capture
  completion, not by URL: each candidate gets a 1×1 screenshot bounded at ~2.5s,
  so such a call can take ~2.5s. Zero or several completers fail with a clear
  error — keep this session's DSH window in front when two views share a URL. A
  restore screen's stale bar never matches.
- No HTTP-cache persistence and no pane mirroring. The cookie jar itself is
  app-wide; only the snapshot files stay per workspace.
- Pane tools other than `browser_open` / `browser_navigate` need a visible pane.
- A hidden pane cannot be screenshotted: the capture fails after 15s and asks you
  to switch to that session.

## Development

```
node --check index.js && for f in lib/*.js; do node --check "$f"; done
node --test
```

`node --test` runs the unit tests for per-view pane selection, visible-bar URL
matching, capture-completion disambiguation of identical URLs (probe bounds,
parallelism, session closure, clear pane errors), restore-screen detection (shell
read and opener), the screenshot timeout and cookie state (no browser, no
network).

## License

MIT — see [LICENSE](LICENSE).
