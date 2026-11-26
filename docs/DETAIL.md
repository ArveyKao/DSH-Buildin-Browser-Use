# Window browser

DSH's built-in browser pane belongs to the **window** that hosts it. Any Session
displayed in that window reads and drives its pane, regardless of which workspace
opened it. The plugin is a native Host cordis bundle (`export function apply(ctx)`),
so it can see the calling Session; it drives DSH's built-in browser over CDP.
Cookie snapshots remain per workspace (see below).

## Tool set

| Tool | Purpose |
|---|---|
| `browser_targets` | List windows, the Session each shows, their panes, and every CDP target |
| `browser_scope_probe` | Same mapping plus the chosen pane, its window and why it was chosen |
| `browser_open` | Open the window's browser pane, optionally loading a URL (the URL is required when no pane exists yet) |
| `browser_attach` | Report the pane the calling Session drives |
| `browser_navigate` | Load a URL in the window's pane |
| `browser_open_external` | Hand a URL to the user's own default browser |
| `browser_snapshot` | Read URL, title, text, links and form fields |
| `browser_click` | Click a CSS selector |
| `browser_type` | Set an input/textarea/select value, optionally pressing Enter |
| `browser_evaluate` | Evaluate JavaScript in the page |
| `browser_screenshot` | Save a PNG under `~/.dsh/browser-state/shots` |

Every tool defaults to the pane of the window showing the calling Session. An
optional `targetId` overrides it, but it must name the `webview` pane hosted by
that same window; an unknown id, a non-pane target, or a pane of another window is
rejected with an error.

## How a window is mapped to a Session

Each DSH window's shell page stores the Session it currently displays:

```
localStorage['dsh.sessions.current']  →  {"sessionId":"session-…"}
```

The plugin reads that value over CDP **per window**, because each window keeps its
own. The pane is the `webview` target whose `parentId` is that window's page target.
Empty, malformed or missing values count as "not readable".

Matching by window title (`<session title> — DeepSeek Harness`) is kept only as a
fallback for builds where no window yields a stored session id.

**Switching sessions inside a window changes the value**, so the pane follows the
Session that is actually displayed there at call time. Any workspace's Session can
be switched into the window and takes the pane over; nothing is refused on the
basis of workspace membership.

## Sharing rules

- One pane per window. Every Session displayed in a window drives that window's
  pane; a Session displayed in another window drives that other window's pane.
- Selection: the window whose stored Session id equals the caller's Session id,
  with the window title as fallback when no window yields a stored id.
- If the caller's window has no pane yet, one is opened there.
- A Session that is not displayed in any open window cannot be routed to a pane. The
  call fails with "this session is not displayed in any open window; switch to it in
  a DSH window first".
- DSH creates the pane's `webview` CDP target only after an HTTP(S) URL has been loaded
  in the pane's address bar (an empty pane never spawns a target). So the first call in
  a window must be `browser_open` (or `browser_navigate`) **with** a URL; every other
  tool requires an already-open pane and fails fast with
  "no browser pane is open in this window; call browser_open with an HTTP(S) url first".
- A freshly opened pane already loaded the requested URL through its address bar, so the
  navigation tools skip `Page.navigate` for it; a reused pane is navigated normally.
  This avoids loading the URL twice.
- An explicit `targetId` must be the pane of the caller's window; a pane hosted by
  another window fails with "is not the pane of the window showing this session".
- A pane renders in one window only; other windows' Sessions do not mirror it.

## Cookie persistence

The built-in browser's cookie jar is in memory, so logins end at every DSH restart.
The jar belongs to the pane and is shared by whoever drives it (DSH behavior), so
files cannot partition it. The plugin snapshots cookies with `Network.getAllCookies`
after each successful call and re-injects them with `Network.setCookies` on first
use in a new process, storing one file per **calling workspace** at
`~/.dsh/browser-state/<workspace-hash>.json` (mode `0600`). (`Storage.getCookies`
returns nothing in this Electron build, hence the Network domain.)

Files are keyed by workspace identity and never merged. Because the jar is shared by
whoever drives the window's pane, each workspace's file captures the jar state at
that workspace's calls. Restore happens once per workspace per process; a failed
restore is retried on the next call. A malformed cookie response is reported and
never overwrites an existing file — tool output shows `persisted: -1` and a failed
restore shows `cookies restored: failed`, without aborting the browser action itself.

## Failure behavior

- A missing CDP endpoint fails every tool with an explicit
  `--remote-debugging-port` / "DSH with CDP" launcher error; no page is touched.
- An invalid or non-pane `targetId` fails instead of silently opening another pane.
- An explicit `targetId` hosted by another window fails instead of driving it.
- A Session not displayed in any open window fails with the switch-to-session message.
- A call that needs a pane but has no URL fails immediately when the caller's window
  has no open pane, instead of opening an empty pane and waiting for a target that
  never appears.
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
- `node --test` runs the unit tests (no browser, no network).
- `node --check` on `index.js` and each file in `lib/` catches syntax errors.
