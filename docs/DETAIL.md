# Workspace browser

Keeps one browser per **workspace** instead of one per session or one global pane.

## Tool set

| Tool | Purpose |
|---|---|
| `browser_targets` | List windows, the Session each shows, their panes, and every CDP target |
| `browser_scope_probe` | Same mapping plus the chosen pane and why it was chosen |
| `browser_open` | Open the workspace browser, optionally loading a URL |
| `browser_attach` | Report the pane workspace-scoped calls use |
| `browser_navigate` | Load a URL in the workspace pane |
| `browser_snapshot` | Read URL, title, text, links and form fields |
| `browser_click` | Click a CSS selector |
| `browser_type` | Set an input value, optionally pressing Enter |
| `browser_evaluate` | Evaluate JavaScript in the page |
| `browser_screenshot` | Save a PNG under `~/.dsh/browser-state/shots` |

Every tool defaults to the calling Session's workspace pane; `targetId` overrides it.

## How a window is mapped to a Session

Each DSH window's shell page stores the Session it currently displays:

```
localStorage['dsh.sessions.current']  →  {"sessionId":"session-…"}
```

The plugin reads that value over CDP **per window**, because each window keeps its
own. A window belongs to a workspace when its id is one of the workspace's sessions,
and the pane is the `webview` target whose `parentId` is that window's page target.

Matching by window title (`<session title> — DeepSeek Harness`) is kept only as a
fallback for builds where the stored value cannot be read.

**Switching sessions inside a window changes the value**, so the mapping follows the
session that is actually displayed there at call time; that is the intended behavior.

## Sharing rules

- Every Session in a workspace drives the same pane: the one opened in any window of
  that workspace. Nothing is selected across workspaces.
- If the workspace has no pane yet, one is opened in the calling Session's window.
- A pane renders in one window only; other Sessions read and drive it, they do not
  mirror it into their own window.

## Cookie persistence

The app's browser partition is per workspace and in memory, so logins end at every
DSH restart. The plugin snapshots cookies with `Storage.getCookies` after each call
and re-injects them with `Network.setCookies` on first use in a new process, storing
one file per workspace at `~/.dsh/browser-state/<workspace-hash>.json`. Cookies are
never mixed between workspaces.

## Requirements

- DSH Desktop must be launched with `--remote-debugging-port=9222` (the `DSH with CDP`
  launcher). Without it, tools report the missing endpoint instead of acting on the
  wrong page.
