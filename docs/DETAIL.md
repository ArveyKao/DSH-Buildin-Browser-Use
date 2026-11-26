# Per-session-view browser

DSH keeps one browser pane **per session view**, not one per window. The plugin
drives the pane that is VISIBLE in the calling Session's own view: it reads the
window's visible address-bar URL, matches it against that window's webview
targets, and loads `browser_open` / `browser_navigate` URLs through that same
visible bar. When several webviews show that same URL, a bounded 1×1 screenshot
probe picks the one whose capture completes (hidden panes never complete).
Other sessions' webviews stay alive but hidden and are never driven.
A view restored from a previous process shows a "Restore page" screen whose bar
is stale and which owns no webview; the opener restores it before loading.
The plugin is a native Host cordis bundle (`export function apply(ctx)`), so it
can see the calling Session; it drives DSH's built-in browser over CDP. Cookie
snapshots remain per workspace (see below).

## Tool set

| Tool | Purpose |
|---|---|
| `browser_targets` | List windows, the Session each shows, each window's visible pane URL and webview count, and every CDP target |
| `browser_scope_probe` | Same mapping plus the pane visible in the caller's view and why it was chosen |
| `browser_open` | Open the pane visible in this session's view, optionally loading a URL (the URL is required when no visible pane exists yet); a restore screen is restored first |
| `browser_attach` | Report the pane visible in this session's view |
| `browser_navigate` | Load a URL in the visible pane |
| `browser_open_external` | Hand a URL to the user's own default browser |
| `browser_snapshot` | Read URL, title, text, links and form fields |
| `browser_click` | Click a CSS selector |
| `browser_type` | Set an input/textarea/select value, optionally pressing Enter |
| `browser_evaluate` | Evaluate JavaScript in the page |
| `browser_screenshot` | Save a PNG under `~/.dsh/browser-state/shots`; fails after 15s on a hidden pane |

Every tool defaults to the pane visible in the calling Session's view. An
optional `targetId` overrides it, but it must name that same pane; an unknown id,
a non-pane target, or any other webview (even one in the same window) is rejected
with an error.

## How the caller's pane is selected

Each DSH window's shell page stores the Session it currently displays:

```
localStorage['dsh.sessions.current']  →  {"sessionId":"session-…"}
```

One shell evaluate per window reads that value **and** the visible address bar:
the first `input` whose placeholder matches `Enter an HTTP(S) address` and whose
`getBoundingClientRect().width > 0`. Hidden views mount their pane UI in the same
shell but report a 0-width bar, so they are skipped. An empty bar value is
`null`. The same evaluate also reports `restoring: true` when a visible
`button`/`a`/`[role="button"]` element whose trimmed `textContent` is exactly
`Restore page` is mounted.

The window whose stored Session id equals the caller's Session id is
authoritative. Within it:

- `views` is every `webview` target whose `parentId` is that window's page
  target — all session views' webviews, visible or hidden.
- `pane` comes from `selectPane(views, visiblePaneUrl, deps)`: both URLs are
  normalized with `URL` (host case folded, a trailing `/` dropped from a non-root
  path). Null/empty/invalid URLs match nothing.
- There is **no first-webview fallback**. A bar value with no matching webview
  means no visible pane yet, even when the window hosts other views' hidden
  webviews.
- When `restoring` is true, `pane` is `null` **regardless of any URL match**.
  The bar belongs to a restore screen ("Previously opened / <title> / Restore
  page") for a pane loaded in a previous process: it is pre-filled with the OLD
  URL and the view has no webview of its own yet. That stale value must never
  pick another view's webview just because the URLs coincide, and it is never
  probed. `visiblePaneUrl` and `views` are still reported.
- **Identical URLs are disambiguated by capture completion.** If several
  webviews show the exact same URL, `selectPane` gives each candidate its own
  CDP session and sends `Page.captureScreenshot` with `format: 'png'` and
  `clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 }`, raced against a
  `CAPTURE_PROBE_TIMEOUT_MS` (2500ms) sleep. Probes run in parallel and every
  probe session is closed in `finally`, so an abandoned capture is rejected
  (never leaked or left hanging) and image data is discarded. Capture completion
  tracks the rendered pane: a hidden pane never completes, and the displayed
  pane completes once its DSH window is front/active.
  - 0 or 1 URL match: used directly, **no probe**.
  - Exactly one candidate completes: that pane is chosen.
  - Zero candidates complete (usually the window is not in front): `pane` is
    `null` with `paneError: 'no-capture'`.
  - Several complete: `pane` is `null` with `paneError: 'ambiguous'`.
  - Both error kinds carry a human `paneErrorMessage` that says the visible pane
    could not be identified and asks to bring this session's DSH window to the
    front and retry. There is no first-match guess, and the message does not
    suggest `browser_open`. An ambiguous same-URL window costs up to ~2.5s per
    selection.

Open-path polling skips the probe (`readWindows(…, { probe: false })`), because
it identifies the spawned webview by target events, so the ~2.5s cost applies to
pane reads and clicks in the ambiguous case, not to every open poll.

Matching by window title (`<session title> — DeepSeek Harness`) is kept only as a
fallback for builds where no window yields a stored session id.

`browser_targets` and `browser_scope_probe` report each window's `paneError`
kind (or `null`) so an ambiguous or not-in-front window can be diagnosed; pane
tools fail with the human message instead of driving a guess.

**Switching sessions switches the visible pane.** The newly displayed view's own
address bar and webview become the target; there is no handover of one shared
page, and the previous view's webview is left untouched.

## Opening a pane in the caller's view

`browser_open` / `browser_navigate` type the URL into the caller view's VISIBLE
address bar (`lib/ops.js` picks the visible input among hidden pane UIs) and press
Enter.

When the caller's view is showing a **restore screen**, the opener first
trusted-clicks its visible "Restore page" button (before focusing or typing into
the bar) and polls — within the same timeout budget — until the affordance is
gone and the visible bar is present. Only then does it focus the bar, type the
URL and press Enter. This is what makes the view spawn its OWN webview instead
of navigating another view's webview: typing into the restore screen's stale bar
otherwise lands in whichever webview that stale URL still matches. The restore
click is also performed when the opener is called without a URL, so the view's
own pane spawns in that case too.

Before opening, the plugin records the window's webview ids and URLs; then
it polls (25 × 300ms) the target list and a fresh window read:

- A webview with an id that did not exist before is the visible view's spawned
  pane (a restore-spawned webview is new too). When several appeared, the one
  matching the refreshed visible-bar URL wins.
- If no new target appears, only a pre-existing view whose URL **changed** to the
  refreshed visible-bar URL is returned (the bar navigated that pane).
- An unchanged pre-existing webview that already showed the URL — typically
  another view's hidden pane — is never accepted. Polling then times out with
  "the browser pane opened but no page target appeared" rather than driving a
  pane the user cannot see.

DSH only spawns a pane's `webview` target after an HTTP(S) URL has been loaded in
its address bar (an empty pane never spawns a target), so the first call in a view
must carry a URL; every other tool requires an already-visible pane and fails
fast with "no browser pane is visible in this session's view; call browser_open
with an HTTP(S) url first".

A freshly opened pane already loaded the requested URL through its bar, so the
navigation tools skip `Page.navigate` for it; a reused pane is navigated
normally. This avoids loading the URL twice.

## Per-view rules

- Each session view drives its own visible pane. Other views' webviews are never
  driven, mirrored or handed over.
- Selection: the window whose stored Session id equals the caller's Session id,
  then the visible-bar URL match inside that window; the window title is a
  fallback only when no window yields a stored id.
- If the caller's view has no visible pane yet, one is opened there through its
  visible bar.
- A view showing a restore screen reports `restoring: true` and no pane; its
  stale bar is never matched, even against an identical URL. Opening clicks
  "Restore page" first so the view's own pane spawns.
- Two or more views showing the identical URL are disambiguated by which pane
  completes a 1×1 capture within ~2.5s (probed in parallel). The one completer is
  driven; zero or several completers fail clearly. Restore screens are never
  probed and never match.
- A Session that is not displayed in any open window cannot be routed to a pane.
  The call fails with "this session is not displayed in any open window; switch
  to it in a DSH window first".
- An explicit `targetId` must be the pane visible in the caller's view; anything
  else fails with "CDP target … is not this session's browser pane".
- `browser_screenshot` bounds `Page.captureScreenshot` at 15s. A hidden webview
  never completes that capture, so the call fails with "screenshot timed out
  after 15s; the pane may be hidden — switch to this session in its DSH window
  and retry" instead of hanging the turn.

## Cookie persistence

The built-in browser's cookie jar is in memory, so logins end at every DSH
restart. The jar itself is shared by the app, so it cannot be partitioned by
workspace; the plugin snapshots it with `Network.getAllCookies` after each
successful call and re-injects it with `Network.setCookies` on first use in a new
process, storing one file per **calling workspace** at
`~/.dsh/browser-state/<workspace-hash>.json` (mode `0600`). (`Storage.getCookies`
returns nothing in this Electron build, hence the Network domain.)

Files are keyed by workspace identity and never merged. Each workspace's file
captures the app-wide jar state at that workspace's calls. Restore happens once
per workspace per process; a failed restore is retried on the next call. A
malformed cookie response is reported and never overwrites an existing file —
tool output shows `persisted: -1` and a failed restore shows
`cookies restored: failed`, without aborting the browser action itself.

## Failure behavior

- A missing CDP endpoint fails every tool with an explicit
  `--remote-debugging-port` / "DSH with CDP" launcher error; no page is touched.
- An invalid or non-pane `targetId` fails instead of silently opening another pane.
- An explicit `targetId` that is not the caller's own visible pane (including
  another view's webview in the same window) fails instead of driving it.
- A Session not displayed in any open window fails with the switch-to-session message.
- Same-URL panes that no probe can disambiguate fail with `paneError`
  `'no-capture'` or `'ambiguous'` and the "bring this session's DSH window to the
  front and retry" message instead of driving a first-match guess.
- A call that needs a pane but has no URL fails immediately when the caller's view
  has no visible pane, instead of opening an empty pane and waiting for a target
  that never appears.
- A restore screen that never resolves fails with "the restored browser pane did
  not finish restoring" instead of typing into the stale bar.
- A screenshot on a hidden pane fails after 15s with the switch-session message
  instead of hanging.
- Read errors for individual windows are reported in `browser_targets` /
  `browser_scope_probe` (`readError`) instead of aborting the whole listing.

## Arming

`package.json` declares `dsh.bundle.patch` → `cordis.patch.yml`. That patch is the
link into DSH: it inserts a plugin with id `workspace-browser`, package name
`@local/dsh-workspace-browser` and `config.cdpEndpoint` (`http://127.0.0.1:9222`
by default).

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
