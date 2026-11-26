/**
 * Workspace-scoped built-in browser control for DSH Desktop.
 *
 * One browser per workspace: any Session in a workspace reads and drives the page
 * another Session opened there, and nothing crosses workspaces. A native Host
 * plugin is required because only a Host tool sees the calling Session
 * (`exec.agent.session`); an MCP stdio server cannot tell callers apart, which is
 * why the earlier MCP bundle drove panes belonging to other windows.
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
import { join } from 'node:path'

import { connect, evaluate, fetchTargets, pressKey, sleep } from './lib/cdp.js'
import { clickScript, openInSystemBrowser, openPaneInWindow, SNAPSHOT_SCRIPT, typeScript } from './lib/ops.js'
import { chooseWorkspacePane, describeTargets, sessionTitle } from './lib/scope.js'
import { bindPane, paneWorkspace, restoreCookiesOnce, snapshotCookies, workspaceKey } from './lib/state.js'
import { readWindows } from './lib/windows.js'

/** Stable Loader identity. */
export const name = 'workspace-browser'

/** Services required before this plugin activates. */
export const inject = ['tools']

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222'

/**
 * Register the workspace-browser tools.
 * @param ctx - plugin registration scope.
 * @param config - optional `{ cdpEndpoint }` from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const endpoint = typeof config.cdpEndpoint === 'string' ? config.cdpEndpoint : DEFAULT_ENDPOINT

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

    const targets = await fetchTargets(endpoint)
    const windows = await readWindows(targets)
    const choice = chooseWorkspacePane(windows, {
      sessionIds,
      titles,
      callerSessionId: session.id,
    })

    return { session, workspace, sessionIds, titles, targets, windows, choice }
  }

  /** Open a pane in the caller's own window and wait for its page target. */
  async function openPaneInCallerWindow(scope, url) {
    const window = scope.choice.callerWindow
    if (window === null) {
      throw new Error(`cannot determine this Session's window: ${scope.choice.reason}`)
    }
    await openPaneInWindow(window.page, url)
    for (let i = 0; i < 25; i += 1) {
      await sleep(300)
      const targets = await fetchTargets(endpoint)
      const pane = targets.find(
        (target) => target.type === 'webview' && target.parentId === window.pageTargetId,
      )
      if (pane) return pane
    }
    throw new Error('the browser pane opened but no page target appeared')
  }

  /**
   * Run a callback against the workspace pane, opening one in the caller's window
   * when the workspace has none yet.
   */
  async function withPane(exec, args, openUrl, callback) {
    const scope = await resolveScope(exec)
    if (scope.workspace === undefined) {
      throw new Error('this Session is not attached to a workspace yet, so no workspace browser exists')
    }

    let pane = args.targetId === undefined
      ? scope.choice.chosen
      : scope.targets.find((target) => target.id === args.targetId) ?? null

    if (pane === null) pane = await openPaneInCallerWindow(scope, openUrl)

    // A pane lives in a window, and that window's Session can change to one from
    // another workspace. Bind the pane to the workspace that first used it and
    // refuse to drive a pane belonging to a different workspace.
    const key = workspaceKey(scope.workspace)
    const bound = paneWorkspace(pane.id)
    if (bound !== undefined && bound !== key) {
      throw new Error(
        `the open browser pane belongs to another workspace (${bound}); ` +
          'close it or switch back to that workspace — refusing to cross workspaces',
      )
    }
    bindPane(pane.id, scope.workspace)

    const session = await connect(pane)
    try {
      let restored = 'skipped'
      try {
        restored = await restoreCookiesOnce(session, scope.workspace)
      } catch {
        restored = 'failed'
      }
      const value = await callback(session, { pane, workspace: scope.workspace })
      let persisted = 0
      try {
        persisted = await snapshotCookies(session, scope.workspace)
      } catch {
        persisted = -1
      }
      return { value, pane, workspace: scope.workspace, restored, persisted }
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
    description: 'Optional CDP target id to override the workspace pane.',
  }

  ctx.tools.register(textTool({
    name: 'browser_targets',
    description: 'List DSH windows, the Session each window shows, and the browser pane each hosts, '
      + 'plus every CDP target. Use it to confirm the built-in browser is reachable and to see '
      + 'which window holds the workspace page.',
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
          workspaceMatch: win.currentSessionId !== null && scope.sessionIds.includes(win.currentSessionId),
        })),
        targets: describeTargets(scope.targets),
      }
      return JSON.stringify(report, null, 2)
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_scope_probe',
    description: 'Report the calling Session, its workspace, every window with the Session it shows, '
      + 'the pane the workspace-scoped algorithm chooses, and why. Use it to diagnose why a browser '
      + 'action landed in the wrong window or found no pane.',
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
          workspaceMatch: win.currentSessionId !== null && scope.sessionIds.includes(win.currentSessionId),
        })),
        chosenPane: scope.choice.chosen === null
          ? null
          : { id: scope.choice.chosen.id, url: scope.choice.chosen.url, title: scope.choice.chosen.title },
        matchedBy: scope.choice.matchedBy,
        reason: scope.choice.reason,
      }
      return JSON.stringify(report, null, 2)
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_open',
    description: 'Open the workspace browser, optionally loading a URL. Reuses the pane another Session '
      + 'of this workspace opened; otherwise opens one in the calling Session\'s own window.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional URL to load after opening.' } },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const result = await withPane(exec, args, args.url, async (session, { pane }) => {
        if (args.url !== undefined) {
          await session.send('Page.enable').catch(() => {})
          await session.send('Page.navigate', { url: args.url })
          await sleep(1200)
        }
        const info = await evaluate(
          session,
          'JSON.stringify({ url: location.href, title: document.title })',
        )
        return `${pane.id} ${info}`
      })
      return `Pane ${result.value} | cookies restored: ${result.restored}, persisted: ${result.persisted}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_attach',
    description: 'Report the pane that workspace-scoped calls use, without navigating. Attaching is '
      + 'implicit for every other browser tool.',
    parameters: { type: 'object', properties: { targetId: targetIdParameter }, additionalProperties: false },
    async execute(args, exec) {
      const result = await withPane(exec, args, undefined, async (session, { pane }) => {
        const info = await evaluate(session, 'JSON.stringify({ url: location.href, title: document.title })')
        return `${pane.id} ${info}`
      })
      return `Attached to ${result.value}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_navigate',
    description: 'Navigate the workspace pane to a URL. Opens a pane in the calling Session\'s window '
      + 'when the workspace has none.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to load.' }, targetId: targetIdParameter },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('url is required')
      const result = await withPane(exec, args, args.url, async (session) => {
        await session.send('Page.enable').catch(() => {})
        const nav = await session.send('Page.navigate', { url: args.url })
        await sleep(1200)
        const errorText = nav?.errorText
        if (typeof errorText === 'string' && errorText.length > 0) {
          // VPN/proxy-only hosts are unreachable from the app's network context.
          await openInSystemBrowser(args.url)
          return JSON.stringify({ url: args.url, unreachableInPane: errorText, handedToSystemBrowser: true })
        }
        return evaluate(session, 'JSON.stringify({ url: location.href, title: document.title, ready: document.readyState })')
      })
      if (result.value.includes('handedToSystemBrowser')) {
        return `The pane could not reach ${args.url} (${result.value}); opened it in your own browser instead.`
      }
      return `Navigated ${result.pane.id}: ${result.value} | cookies restored: ${result.restored}, persisted: ${result.persisted}`
    },
  }))

  ctx.tools.register(textTool({
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
      await openInSystemBrowser(args.url)
      return `Opened ${args.url} in your default browser.`
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_snapshot',
    description: 'Read the workspace pane: URL, title, visible text, links and form fields.',
    parameters: { type: 'object', properties: { targetId: targetIdParameter }, additionalProperties: false },
    async execute(args, exec) {
      const result = await withPane(exec, args, undefined, async (session) => evaluate(session, SNAPSHOT_SCRIPT))
      return result.value
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_click',
    description: 'Click the first element matching a CSS selector in the workspace pane.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector.' }, targetId: targetIdParameter },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args.selector !== 'string') throw new Error('selector is required')
      const result = await withPane(exec, args, undefined, async (session) => {
        const outcome = await evaluate(session, clickScript(args.selector))
        await sleep(600)
        return String(outcome)
      })
      return `Click ${args.selector}: ${result.value} | cookies persisted: ${result.persisted}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_type',
    description: 'Set an input value in the workspace pane and fire input/change, optionally pressing Enter.',
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
      const result = await withPane(exec, args, undefined, async (session) => {
        const outcome = await evaluate(session, typeScript(args.selector, args.text ?? ''))
        if (outcome === 'typed' && args.submit === true) {
          await pressKey(session, { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' })
          await sleep(900)
        }
        return String(outcome)
      })
      return `Type ${args.selector}: ${result.value} | cookies persisted: ${result.persisted}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the workspace pane and return its value.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'Expression to evaluate.' }, targetId: targetIdParameter },
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args.expression !== 'string') throw new Error('expression is required')
      const result = await withPane(exec, args, undefined, async (session) => {
        const value = await evaluate(session, args.expression)
        return typeof value === 'string' ? value : JSON.stringify(value)
      })
      return result.value
    },
  }))

  ctx.tools.register(textTool({
    name: 'browser_screenshot',
    description: 'Capture a PNG of the workspace pane and save it under ~/.dsh/browser-state/shots.',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string', description: 'Optional absolute output path.' }, targetId: targetIdParameter },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const result = await withPane(exec, args, undefined, async (session) => {
        const shot = await session.send('Page.captureScreenshot', { format: 'png' })
        const path = typeof args.filePath === 'string'
          ? args.filePath
          : join(homedir(), '.dsh', 'browser-state', 'shots', `shot-${Date.now()}.png`)
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, Buffer.from(shot.data, 'base64'))
        return path
      })
      return `Saved ${result.value}`
    },
  }))
}
