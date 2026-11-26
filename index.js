/**
 * Per-session-view built-in browser control for DSH Desktop.
 *
 * DSH keeps one browser-pane UI per session VIEW: each view in a window has its
 * own address bar and webview target, and only the view the user is looking at
 * is visible. The tools therefore drive the pane VISIBLE in the caller's view:
 * the window's visible address-bar URL is matched against that window's webview
 * targets, and when several webviews show that same URL only the one completing
 * a frame capture is chosen (hidden panes never complete), and `browser_open`
 * loads the URL through the caller's visible bar.
 * Other session views' webviews are never driven. A view restored from a
 * previous process shows a "Restore page" screen whose bar is stale and which
 * owns no webview; `browser_open` trusted-clicks Restore page first. A Session
 * not shown in any window gets a clear error. Cookie snapshots stay keyed by the
 * calling Session's workspace.
 *
 * A native Host plugin is required because only a Host tool sees the calling
 * Session (`exec.agent.session`); an MCP stdio server cannot tell callers apart,
 * which is why the earlier MCP bundle drove panes belonging to other windows.
 *
 * Window → Session mapping uses the exact bridge each window writes to its own
 * `localStorage['dsh.sessions.current']`, with window-title matching only as a
 * fallback. See `lib/windows.js` and `lib/scope.js`.
 *
 * This bundle imports nothing from `@deepseek-ai/*`: a linked local bundle
 * resolves bare specifiers from its own directory, which has no node_modules.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { connect, evaluate, fetchTargets, pressKey, sleep } from './lib/cdp.js'
import { clickScript, openInSystemBrowser, openPaneInWindow, SNAPSHOT_SCRIPT, typeScript } from './lib/ops.js'
import { chooseCallerPane, describeTargets, matchVisiblePane, sessionTitle } from './lib/scope.js'
import { restoreCookiesOnce, snapshotCookies } from './lib/state.js'
import { readWindows } from './lib/windows.js'

/** Stable Loader identity. */
export const name = 'workspace-browser'

/** Services required before this plugin activates. */
export const inject = ['tools']

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222'

/** `Page.captureScreenshot` never completes on a hidden webview, so bound it. */
const SCREENSHOT_TIMEOUT_MS = 15000
const SCREENSHOT_TIMED_OUT = Symbol('screenshot-timed-out')

/** CDP operations the tools use; tests replace this bundle with doubles. */
const DEFAULT_CDP = {
  connect,
  evaluate,
  fetchTargets,
  openInSystemBrowser,
  openPaneInWindow,
  pressKey,
  readWindows,
  sleep,
}

/**
 * Build the workspace-browser tool definitions.
 * @param ctx - plugin registration scope (workspace and session services).
 * @param endpoint - CDP endpoint of the DSH app.
 * @param cdp - CDP operations; production uses `DEFAULT_CDP`.
 */
export function createTools({ ctx, endpoint = DEFAULT_ENDPOINT, cdp = DEFAULT_CDP } = {}) {
  const tools = []

  /** Resolve the calling Session, its workspace, windows and chosen pane. */
  async function resolveScope(exec) {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('browser tools require a Session-bound agent')

    const registry = ctx.get('workspaceRegistry')
    const sessions = ctx.get('sessions')
    const workspaces = typeof registry?.list === 'function' ? registry.list() : []
    const workspace = workspaces.find(
      (candidate) => Array.isArray(candidate.sessionIds) && candidate.sessionIds.includes(session.id),
    )

    const sessionIds = workspace?.sessionIds ?? []
    const titles = {}
    for (const id of sessionIds) {
      if (id === session.id) {
        titles[id] = sessionTitle(session) ?? null
        continue
      }
      const live = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
      titles[id] = sessionTitle(live) ?? null
    }

    const targets = await cdp.fetchTargets(endpoint)
    const windows = await cdp.readWindows(targets)
    const choice = chooseCallerPane(windows, {
      callerSessionId: session.id,
      callerTitle: sessionTitle(session),
      titles,
    })

    return { session, workspace, sessionIds, titles, targets, windows, choice }
  }

  /** Window rows shared by the listing/diagnostic tools. */
  function describeWindows(scope) {
    return scope.windows.map((win) => ({
      pageTargetId: win.pageTargetId,
      windowTitle: win.pageTitle,
      currentSessionId: win.currentSessionId,
      visiblePaneUrl: win.visiblePaneUrl,
      restoring: win.restoring === true,
      readError: win.readError,
      webviewCount: win.views.length,
      paneTargetId: win.pane?.id ?? null,
      paneUrl: win.pane?.url ?? null,
      paneError: win.paneError ?? null,
      showsCaller: win.currentSessionId === scope.session.id,
      workspaceMatch: win.currentSessionId !== null && scope.sessionIds.includes(win.currentSessionId),
    }))
  }

  /**
   * Open a pane in the session view showing the calling Session by loading `url`
   * through that view's VISIBLE address bar, then wait for its webview target.
   *
   * DSH only spawns a pane's webview CDP target once an HTTP(S) URL has been
   * loaded, so waiting after opening an empty pane can never succeed. The
   * window's webview ids and URLs are captured first. A fresh id means the
   * visible view spawned its pane; without one, only a pre-existing view whose
   * URL CHANGED to the refreshed visible-bar URL counts as the bar's target.
   * A hidden view that already showed that URL stays untouched. A view restored
   * from a previous process spawns its own pane when the opener trusted-clicks
   * Restore page, so that pane is a fresh id too.
   */
  async function openPaneInCallerWindow(scope, url) {
    const window = scope.choice.callerWindow
    if (window === null) {
      throw new Error(`cannot open a browser: ${scope.choice.reason}`)
    }
    const before = new Map(window.views.map((view) => [view.id, view.url ?? '']))
    await cdp.openPaneInWindow(window.page, url)
    for (let i = 0; i < 25; i += 1) {
      await cdp.sleep(300)
      const targets = await cdp.fetchTargets(endpoint)
      // Polling identifies the spawned view by target events, never by `pane`,
      // so skip the capture probe's ~2.5s cost on every poll.
      const windows = await cdp.readWindows(targets, {}, { probe: false })
      const refreshed = windows.find((candidate) => candidate.pageTargetId === window.pageTargetId)
      if (refreshed === undefined) continue
      const spawned = refreshed.views.filter((view) => !before.has(view.id))
      if (spawned.length > 0) {
        return matchVisiblePane(spawned, refreshed.visiblePaneUrl) ?? spawned[0]
      }
      const matched = matchVisiblePane(refreshed.views, refreshed.visiblePaneUrl)
      if (matched !== null && (matched.url ?? '') !== (before.get(matched.id) ?? '')) {
        return matched
      }
    }
    throw new Error('the browser pane opened but no page target appeared')
  }

  /**
   * Resolve the pane for one call: the pane visible in the caller's session view
   * by default, or an explicit `targetId` that must be that same pane.
   */
  function resolvePane(scope, targetId) {
    if (targetId === undefined) return scope.choice.chosen

    const target = scope.targets.find((candidate) => candidate.id === targetId)
    if (target === undefined) {
      throw new Error(`no CDP target with id ${targetId}; call browser_targets to list targets`)
    }
    if (target.type !== 'webview') {
      throw new Error(`CDP target ${targetId} is a ${target.type}, not a browser pane`)
    }
    if (target.id !== scope.choice.chosen?.id) {
      throw new Error(
        `CDP target ${targetId} is not this session's browser pane; call browser_targets to list targets`,
      )
    }
    return target
  }

  /**
   * Run a callback against the browser pane visible in the caller's session view.
   * @param exec - tool execution context (carries the calling Session).
   * @param args - tool arguments; `targetId` overrides the caller's visible pane.
   * @param openUrl - HTTP(S) URL used when a pane must be opened; undefined when
   *   the call may only reuse an existing pane.
   * @param callback - `(cdpSession, { pane, workspace, opened }) => value`;
   *   `opened` says the pane just loaded `openUrl` through its address bar.
   */
  async function withPane(exec, args, openUrl, callback) {
    const scope = await resolveScope(exec)
    if (scope.workspace === undefined) {
      throw new Error('this Session is not attached to a workspace yet, so cookies cannot be stored')
    }
    // A same-URL ambiguity is not a "no pane yet" state: opening another pane
    // or retrying browser_open cannot identify the visible one, so fail before
    // resolvePane and the open path with the probe's own message.
    if (scope.choice.paneError) {
      throw new Error(scope.choice.paneErrorMessage
        ?? "could not identify the browser pane visible in this session's view; bring this session's DSH window to the front and retry")
    }

    let pane = resolvePane(scope, args.targetId)
    let opened = false
    if (pane === null) {
      if (openUrl === undefined) {
        // Opening an empty pane yields no webview target, so waiting for one
        // only burns the timeout; fail fast and name the tool that can open it.
        throw new Error(
          "no browser pane is visible in this session's view; call browser_open with an HTTP(S) url first",
        )
      }
      pane = await openPaneInCallerWindow(scope, openUrl)
      opened = true
    }

    const session = await cdp.connect(pane)
    try {
      let restored = 'skipped'
      try {
        restored = await restoreCookiesOnce(session, scope.workspace)
      } catch {
        restored = 'failed'
      }
      const value = await callback(session, { pane, workspace: scope.workspace, opened })
      let persisted = 0
      try {
        persisted = await snapshotCookies(session, scope.workspace)
      } catch {
        persisted = -1
      }
      return { value, pane, workspace: scope.workspace, opened, restored, persisted }
    } finally {
      session.close()
    }
  }

  /** A tool definition whose result is rendered as text. */
  const textTool = (definition) => ({
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    ...definition,
  })

  const targetIdParameter = {
    type: 'string',
    description: "Optional CDP target id; it must be the pane visible in this session's view.",
  }

  tools.push(textTool({
    name: 'browser_targets',
    description: 'List DSH windows, the Session each window shows, the visible pane URL and every '
      + 'webview each window hosts, plus every CDP target. Use it to confirm the built-in browser '
      + "is reachable and to see which webview is the pane visible in this session's view.",
    async execute(_args, exec) {
      const scope = await resolveScope(exec)
      const report = {
        cdpEndpoint: endpoint,
        sessionId: scope.session.id,
        workspace: scope.workspace === undefined
          ? null
          : { id: scope.workspace.id ?? null, path: scope.workspace.path ?? null, sessionIds: scope.sessionIds },
        windows: describeWindows(scope),
        targets: describeTargets(scope.targets),
      }
      return JSON.stringify(report, null, 2)
    },
  }))

  tools.push(textTool({
    name: 'browser_scope_probe',
    description: 'Report the calling Session, its workspace, every window with the Session it shows, '
      + "each window's visible pane URL and webview count, the pane visible in the caller's view, "
      + 'and why. Use it to diagnose why a browser action found no pane or landed in the wrong view.',
    async execute(_args, exec) {
      const scope = await resolveScope(exec)
      const report = {
        cdpEndpoint: endpoint,
        sessionId: scope.session.id,
        sessionTitle: sessionTitle(scope.session) ?? null,
        workspace: scope.workspace === undefined
          ? null
          : { id: scope.workspace.id ?? null, path: scope.workspace.path ?? null, sessionIds: scope.sessionIds },
        workspaceSessionTitles: scope.titles,
        windows: describeWindows(scope),
        chosenPane: scope.choice.chosen === null
          ? null
          : { id: scope.choice.chosen.id, url: scope.choice.chosen.url, title: scope.choice.chosen.title },
        matchedBy: scope.choice.matchedBy,
        paneError: scope.choice.paneError ?? null,
        reason: scope.choice.reason,
        callerWindowId: scope.choice.callerWindow?.pageTargetId ?? null,
      }
      return JSON.stringify(report, null, 2)
    },
  }))

  tools.push(textTool({
    name: 'browser_open',
    description: "Open the browser pane visible in this session's view, optionally loading a URL. "
      + 'Reuses that visible pane; otherwise restores a previously opened pane if its restore '
      + 'screen is showing, then loads the URL through the visible address bar, which spawns the '
      + 'pane, so a URL is required in that case.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional URL to load after opening.' } },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (args.url !== undefined && (typeof args.url !== 'string' || args.url.length === 0)) {
        throw new Error('url must be a non-empty string')
      }
      const result = await withPane(exec, args, args.url, async (session, { pane, opened }) => {
        // A freshly opened pane already loaded args.url through its address bar.
        if (args.url !== undefined && !opened) {
          await session.send('Page.enable').catch(() => {})
          await session.send('Page.navigate', { url: args.url })
          await cdp.sleep(1200)
        }
        const info = await cdp.evaluate(
          session,
          'JSON.stringify({ url: location.href, title: document.title })',
        )
        return { paneId: pane.id, info }
      })
      return `Pane ${result.value.paneId} ${result.value.info} | cookies restored: ${result.restored}, persisted: ${result.persisted}`
    },
  }))

  tools.push(textTool({
    name: 'browser_attach',
    description: "Report the pane visible in this session's view, without navigating. Attaching is "
      + 'implicit for every other browser tool.',
    parameters: { type: 'object', properties: { targetId: targetIdParameter }, additionalProperties: false },
    async execute(args, exec) {
      const result = await withPane(exec, args, undefined, async (session, { pane }) => {
        const info = await cdp.evaluate(session, 'JSON.stringify({ url: location.href, title: document.title })')
        return `${pane.id} ${info}`
      })
      return `Attached to ${result.value}`
    },
  }))

  tools.push(textTool({
    name: 'browser_navigate',
    description: "Navigate the browser pane visible in this session's view to a URL. When that view "
      + 'has no pane yet, opens one by loading the URL through its visible address bar.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to load.' }, targetId: targetIdParameter },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('url is required')
      const result = await withPane(exec, args, args.url, async (session, { opened }) => {
        // The address bar already loaded args.url into a freshly opened pane;
        // navigating again would load it twice.
        let nav = null
        if (!opened) {
          await session.send('Page.enable').catch(() => {})
          nav = await session.send('Page.navigate', { url: args.url })
          await cdp.sleep(1200)
        }
        const errorText = nav?.errorText
        if (typeof errorText === 'string' && errorText.length > 0) {
          // VPN/proxy-only hosts are unreachable from the app's network context.
          await cdp.openInSystemBrowser(args.url)
          return { handedToSystemBrowser: true, errorText }
        }
        const info = await cdp.evaluate(session, 'JSON.stringify({ url: location.href, title: document.title, ready: document.readyState })')
        return { handedToSystemBrowser: false, info }
      })
      if (result.value.handedToSystemBrowser) {
        return `The pane could not reach ${args.url} (${result.value.errorText}); opened it in your own browser instead.`
      }
      return `Navigated ${result.pane.id}: ${result.value.info} | cookies restored: ${result.restored}, persisted: ${result.persisted}`
    },
  }))

  tools.push(textTool({
    name: 'browser_open_external',
    description: 'Open a URL in the user\'s own default browser instead of the DSH pane. Use for hosts the '
      + 'pane cannot reach (VPN/proxy only) or when the user wants their real browser profile. Nothing is '
      + 'automated there afterwards.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open.' } },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args) {
      if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('url is required')
      await cdp.openInSystemBrowser(args.url)
      return `Opened ${args.url} in your default browser.`
    },
  }))

  tools.push(textTool({
    name: 'browser_snapshot',
    description: "Read the browser pane visible in this session's view: URL, title, visible text, "
      + 'links and form fields.',
    parameters: { type: 'object', properties: { targetId: targetIdParameter }, additionalProperties: false },
    async execute(args, exec) {
      const result = await withPane(exec, args, undefined, async (session) => cdp.evaluate(session, SNAPSHOT_SCRIPT))
      return result.value
    },
  }))

  tools.push(textTool({
    name: 'browser_click',
    description: "Click the first element matching a CSS selector in the pane visible in this session's view.",
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector.' }, targetId: targetIdParameter },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args.selector !== 'string') throw new Error('selector is required')
      const result = await withPane(exec, args, undefined, async (session) => {
        const outcome = await cdp.evaluate(session, clickScript(args.selector))
        await cdp.sleep(600)
        return String(outcome)
      })
      return `Click ${args.selector}: ${result.value} | cookies persisted: ${result.persisted}`
    },
  }))

  tools.push(textTool({
    name: 'browser_type',
    description: "Set an input value in the pane visible in this session's view and fire "
      + 'input/change, optionally pressing Enter.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector.' },
        text: { type: 'string', description: 'Value to set.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        targetId: targetIdParameter,
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args.selector !== 'string') throw new Error('selector is required')
      if (args.text !== undefined && typeof args.text !== 'string') throw new Error('text must be a string')
      const result = await withPane(exec, args, undefined, async (session) => {
        const outcome = await cdp.evaluate(session, typeScript(args.selector, args.text ?? ''))
        if (outcome === 'typed' && args.submit === true) {
          await cdp.pressKey(session, { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' })
          await cdp.sleep(900)
        }
        return String(outcome)
      })
      return `Type ${args.selector}: ${result.value} | cookies persisted: ${result.persisted}`
    },
  }))

  tools.push(textTool({
    name: 'browser_evaluate',
    description: "Evaluate a JavaScript expression in the pane visible in this session's view and "
      + 'return its value.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'Expression to evaluate.' }, targetId: targetIdParameter },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args.expression !== 'string') throw new Error('expression is required')
      const result = await withPane(exec, args, undefined, async (session) => {
        const value = await cdp.evaluate(session, args.expression)
        if (value === undefined) return 'undefined'
        return typeof value === 'string' ? value : JSON.stringify(value)
      })
      return result.value
    },
  }))

  tools.push(textTool({
    name: 'browser_screenshot',
    description: "Capture a PNG of the pane visible in this session's view and save it under "
      + '~/.dsh/browser-state/shots. Fails after 15s with a clear error when that pane is hidden; '
      + 'switch to this session in its DSH window and retry.',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string', description: 'Optional absolute output path.' }, targetId: targetIdParameter },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (args.filePath !== undefined && (typeof args.filePath !== 'string' || args.filePath.length === 0)) {
        throw new Error('filePath must be a non-empty string')
      }
      const result = await withPane(exec, args, undefined, async (session) => {
        // A hidden webview produces no frames, so a bare send can hang the whole
        // turn; `withPane`'s finally closes the session and rejects the send.
        const shot = await Promise.race([
          session.send('Page.captureScreenshot', { format: 'png' }),
          cdp.sleep(SCREENSHOT_TIMEOUT_MS).then(() => SCREENSHOT_TIMED_OUT),
        ])
        if (shot === SCREENSHOT_TIMED_OUT) {
          throw new Error(
            'screenshot timed out after 15s; the pane may be hidden — switch to this session in its '
              + 'DSH window and retry',
          )
        }
        const path = typeof args.filePath === 'string'
          ? args.filePath
          : join(homedir(), '.dsh', 'browser-state', 'shots', `shot-${Date.now()}.png`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, Buffer.from(shot.data, 'base64'))
        return path
      })
      return `Saved ${result.value}`
    },
  }))

  return tools
}

/**
 * Register the workspace-browser tools.
 * @param ctx - plugin registration scope.
 * @param config - optional `{ cdpEndpoint }` from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const endpoint = typeof config?.cdpEndpoint === 'string' ? config.cdpEndpoint : DEFAULT_ENDPOINT
  for (const tool of createTools({ ctx, endpoint })) ctx.tools.register(tool)
}
