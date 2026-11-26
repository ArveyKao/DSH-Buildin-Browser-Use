/**
 * Window-scoped built-in browser control for DSH Desktop.
 *
 * The browser pane belongs to the WINDOW that hosts it: any Session displayed in
 * that window reads and drives its pane, whichever workspace opened it. DSH lets
 * the user switch any Session into any window, so switching sessions hands the
 * pane over instead of orphaning it; a Session not shown in any window gets a
 * clear error. Cookie snapshots stay keyed by the calling Session's workspace.
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
import { chooseCallerPane, describeTargets, sessionTitle } from './lib/scope.js'
import { restoreCookiesOnce, snapshotCookies } from './lib/state.js'
import { readWindows } from './lib/windows.js'

/** Stable Loader identity. */
export const name = 'workspace-browser'

/** Services required before this plugin activates. */
export const inject = ['tools']

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222'

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

  /**
   * Open a pane in the window showing the calling Session, loading `url` through
   * its address bar, and wait for its page target.
   *
   * DSH only spawns the pane's webview CDP target once an HTTP(S) URL has been
   * loaded, so waiting after opening an empty pane can never succeed.
   */
  async function openPaneInCallerWindow(scope, url) {
    const window = scope.choice.callerWindow
    if (window === null) {
      throw new Error(`cannot open a browser: ${scope.choice.reason}`)
    }
    await cdp.openPaneInWindow(window.page, url)
    for (let i = 0; i < 25; i += 1) {
      await cdp.sleep(300)
      const targets = await cdp.fetchTargets(endpoint)
      const pane = targets.find(
        (target) => target.type === 'webview' && target.parentId === window.pageTargetId,
      )
      if (pane) return pane
    }
    throw new Error('the browser pane opened but no page target appeared')
  }

  /**
   * Resolve the pane for one call: the pane of the caller's window by default, or
   * an explicit `targetId` that must be hosted by that same window.
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
    if (target.parentId !== scope.choice.callerWindow?.pageTargetId) {
      throw new Error(
        `CDP target ${targetId} is not the pane of the window showing this session; ` +
          'call browser_targets to list targets',
      )
    }
    return target
  }

  /**
   * Run a callback against the browser pane of the caller's window.
   * @param exec - tool execution context (carries the calling Session).
   * @param args - tool arguments; `targetId` overrides the caller-window pane.
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

    let pane = resolvePane(scope, args.targetId)
    let opened = false
    if (pane === null) {
      if (openUrl === undefined) {
        // Opening an empty pane yields no webview target, so waiting for one
        // only burns the timeout; fail fast and name the tool that can open it.
        throw new Error(
          'no browser pane is open in this window; call browser_open with an HTTP(S) url first',
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
    description: 'Optional CDP target id; it must be the pane of the window showing this session.',
  }

  tools.push(textTool({
    name: 'browser_targets',
    description: 'List DSH windows, the Session each window shows, and the browser pane each hosts, '
      + 'plus every CDP target. Use it to confirm the built-in browser is reachable and to see '
      + 'which window holds the pane this session drives.',
    async execute(_args, exec) {
      const scope = await resolveScope(exec)
      const report = {
        cdpEndpoint: endpoint,
        sessionId: scope.session.id,
        workspace: scope.workspace === undefined
          ? null
          : { id: scope.workspace.id ?? null, path: scope.workspace.path ?? null, sessionIds: scope.sessionIds },
        windows: scope.windows.map((win) => ({
          pageTargetId: win.pageTargetId,
          windowTitle: win.pageTitle,
          currentSessionId: win.currentSessionId,
          readError: win.readError,
          paneTargetId: win.pane?.id ?? null,
          paneUrl: win.pane?.url ?? null,
          showsCaller: win.currentSessionId === scope.session.id,
          workspaceMatch: win.currentSessionId !== null && scope.sessionIds.includes(win.currentSessionId),
        })),
        targets: describeTargets(scope.targets),
      }
      return JSON.stringify(report, null, 2)
    },
  }))

  tools.push(textTool({
    name: 'browser_scope_probe',
    description: 'Report the calling Session, its workspace, every window with the Session it shows, '
      + 'the pane the caller-window algorithm chooses, and why. Use it to diagnose why a browser '
      + 'action found no pane or landed in the wrong window.',
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
        windows: scope.windows.map((win) => ({
          pageTargetId: win.pageTargetId,
          windowTitle: win.pageTitle,
          currentSessionId: win.currentSessionId,
          readError: win.readError,
          paneTargetId: win.pane?.id ?? null,
          paneUrl: win.pane?.url ?? null,
          showsCaller: win.currentSessionId === scope.session.id,
          workspaceMatch: win.currentSessionId !== null && scope.sessionIds.includes(win.currentSessionId),
        })),
        chosenPane: scope.choice.chosen === null
          ? null
          : { id: scope.choice.chosen.id, url: scope.choice.chosen.url, title: scope.choice.chosen.title },
        matchedBy: scope.choice.matchedBy,
        reason: scope.choice.reason,
        callerWindowId: scope.choice.callerWindow?.pageTargetId ?? null,
      }
      return JSON.stringify(report, null, 2)
    },
  }))

  tools.push(textTool({
    name: 'browser_open',
    description: 'Open the browser pane of the window showing this session, optionally loading a URL. '
      + 'Reuses that window\'s pane, whichever workspace opened it; otherwise opens one, which requires a URL.',
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
    description: 'Report the pane this session drives, without navigating. Attaching is '
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
    description: 'Navigate the browser pane of the window showing this session to a URL. Opens a pane '
      + 'there when the window has none; a freshly opened pane loads the URL through its address bar.',
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
    description: 'Read the browser pane of the window showing this session: URL, title, visible text, '
      + 'links and form fields.',
    parameters: { type: 'object', properties: { targetId: targetIdParameter }, additionalProperties: false },
    async execute(args, exec) {
      const result = await withPane(exec, args, undefined, async (session) => cdp.evaluate(session, SNAPSHOT_SCRIPT))
      return result.value
    },
  }))

  tools.push(textTool({
    name: 'browser_click',
    description: 'Click the first element matching a CSS selector in the pane of the window showing this session.',
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
    description: 'Set an input value in the pane of the window showing this session and fire '
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
    description: 'Evaluate a JavaScript expression in the pane of the window showing this session and '
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
    description: 'Capture a PNG of the pane of the window showing this session and save it under '
      + '~/.dsh/browser-state/shots.',
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
        const shot = await session.send('Page.captureScreenshot', { format: 'png' })
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
