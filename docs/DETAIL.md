# Workspace browser

Keeps one browser per **workspace** instead of one per session or one global pane.
The plugin is a native Host cordis bundle (`export function apply(ctx)`), so it can
see the calling Session; it drives DSH's built-in browser over CDP.

## Tool set

| Tool | Purpose |
|---|---|
| `browser_targets` | List windows, the Session each shows, their panes, and every CDP target |
| `browser_scope_probe` | Same mapping plus the chosen pane, its host window and why it was chosen |
| `browser_open` | Open the workspace browser, optionally loading a URL |
| `browser_attach` | Report the pane workspace-scoped calls use |
| `browser_navigate` | Load a URL in the workspace pane |
| `browser_open_external` | Hand a URL to the user's own default browser |
| `browser_snapshot` | Read URL, title, text, links and form fields |
| `browser_click` | Click a CSS selector |
| `browser_type` | Set an input/textarea/select value, optionally pressing Enter |
| `browser_evaluate` | Evaluate JavaScript in the page |
| `browser_screenshot` | Save a PNG under `~/.dsh/browser-state/shots` |

Every tool defaults to the calling Session's workspace pane. An optional
`targetId` overrides it, but it must name a `webview` pane target of this
workspace; an unknown id, a non-pane target, or a pane hosted by another
workspace's window is rejected with an error.

## How a window is mapped to a Session

Each DSH window's shell page stores the Session it currently displays:

```
localStorage['dsh.sessions.current']  →  {"sessionId":"session-…"}
```

The plugin reads that value over CDP **per window**, because each window keeps its
own. A window belongs to a workspace when its id is one of the workspace's sessions,
and the pane is the `webview` target whose `parentId` is that window's page target.
Empty, malformed or missing values count as "not readable".

Matching by window title (`<session title> — DeepSeek Harness`) is kept only as a
fallback for builds where no window yields a stored session id.

**Switching sessions inside a window changes the value**, so the mapping follows the
session that is actually displayed there at call time; that is the intended behavior.

## Sharing rules

- Every Session in a workspace drives the same pane: the one opened in any window of
  that workspace. Nothing is selected across workspaces.
- Selection order: the caller window's pane, then any other window's pane of the same
  workspace, then the window that should host a new one.
- If the workspace has no pane yet, one is opened in the calling Session's window; when
  the calling Session is not displayed in any window, another window of the same
  workspace hosts it.
- A pane is bound to the workspace that first drove it; later calls from a different
  workspace are refused rather than served the wrong page.
- A pane renders in one window only; other Sessions read and drive it, they do not
  mirror it into their own window.

## Cookie persistence

The app's browser partition is per workspace and in memory, so logins end at every DSH
restart. The plugin snapshots cookies with `Network.getAllCookies` after each successful
call and re-injects them with `Network.setCookies` on first use in a new process,
storing one file per workspace at `~/.dsh/browser-state/<workspace-hash>.json` (mode
`0600`). (`Storage.getCookies` returns nothing in this Electron build, hence the Network
domain.) Cookies are never mixed between workspaces. Restore happens once per workspace
per process; a failed restore is retried on the next call. A malformed cookie response
is reported and never overwrites an existing file — tool output shows
`persisted: -1` and a failed restore shows `cookies restored: failed`, without aborting
the browser action itself.

## Failure behavior

- A missing CDP endpoint fails every tool with an explicit
  `--remote-debugging-port` / "DSH with CDP" launcher error; no page is touched.
- An invalid or non-pane `targetId` fails instead of silently opening another pane.
- A pane bound to another workspace fails with "refusing to cross workspaces".
- Read errors for individual windows are reported in `browser_targets` /
  `browser_scope_probe` (`readError`) instead of aborting the whole listing.

## Arming

`package.json` declares `dsh.bundle.patch` → `cordis.patch.yml`. That patch is the
link into DSH: it inserts a plugin with id `workspace-browser`, package name
`@local/dsh-workspace-browser` and `config.cdpEndpoint` (`http://127.0.0.1:9222` by
default).

1. Make this directory resolvable to DSH as `@local/dsh-workspace-browser` (link or
   copy it where DSH loads local bundles; it has no dependencies to install).
2. Restart DSH so the Host plugin loads alongside its `tools` service; the
   `browser_*` tools appear.
3. Launch DSH Desktop through the **"DSH with CDP"** launcher, i.e. with
   `--remote-debugging-port=9222`. Confirm with
   `curl http://127.0.0.1:9222/json/version`; without the flag the tools fail with the
   endpoint error instead of acting on the wrong page.

Disarm by removing the inserted patch entry and restarting DSH.

## Requirements and checks

- DSH Desktop with its built-in browser, Node >= 22 (no npm dependencies).
- `node --test tests/` runs the unit tests (no browser, no network).
- `node --check` on `index.js` and each file in `lib/` catches syntax errors.
