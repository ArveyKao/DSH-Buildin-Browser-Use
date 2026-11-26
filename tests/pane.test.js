import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTools } from '../index.js'
import { loadCookies, saveCookies } from '../lib/state.js'

// Cookie restore/snapshot resolve ~/.dsh/browser-state on every call.
let home

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-workspace-browser-pane-'))
  process.env.HOME = home
})

after(async () => {
  await rm(home, { recursive: true, force: true })
})

const PAGE = { id: 'window-1', type: 'page', title: 'Session — DeepSeek Harness' }
const PANE = { id: 'pane-1', type: 'webview', parentId: 'window-1', url: 'https://example.com/' }
const EXEC = { agent: { session: { id: 'session-a' } } }

const WS_A = { id: 'ws-a', path: '/ws-a', sessionIds: ['session-a', 'session-a2'] }
const WS_B = { id: 'ws-b', path: '/ws-b', sessionIds: ['session-b'] }

const cookie = (name, value) => ({ name, value, domain: 'example.com', path: '/' })

function fakeCtx(workspaces = [WS_A, WS_B]) {
  return {
    get(key) {
      if (key === 'workspaceRegistry') return { list: () => workspaces }
      if (key === 'sessions') return { get: () => undefined }
      return undefined
    },
  }
}

/** A window record shaped like `readWindows` output. */
function windowRecord({ id = 'window-1', sessionId = 'session-a', paneId = null, title = 'Session — DeepSeek Harness' }) {
  return {
    pageTargetId: id,
    pageTitle: title,
    page: { id, type: 'page', title },
    currentSessionId: sessionId,
    readError: null,
    pane: paneId === null ? null : { id: paneId, type: 'webview', parentId: id, url: `https://${paneId}.example/` },
  }
}

/** CDP session double that records every command. */
function fakeSession(state) {
  const calls = []
  return {
    calls,
    closed: false,
    async send(method, params = {}) {
      calls.push({ method, params })
      if (method === 'Network.getAllCookies') return { cookies: state.cookies }
      return {}
    },
    close() {
      this.closed = true
    },
  }
}

/**
 * Tool set wired to fake CDP operations. `pane` starts as the window's existing
 * pane or null; opening one adds `PANE`, mirroring DSH. `windows` overrides the
 * default single-window view for read-only scenarios.
 */
function harness({ pane = null, currentSessionId = 'session-a', windows, workspaces, cookies = [] } = {}) {
  const state = { pane, openCalls: [], sleeps: 0, evaluates: [], cookies }
  const session = fakeSession(state)
  const cdp = {
    async fetchTargets() {
      if (windows !== undefined) {
        return windows.flatMap((win) => [win.page, ...(win.pane === null ? [] : [win.pane])])
      }
      return state.pane === null ? [PAGE] : [PAGE, state.pane]
    },
    async readWindows() {
      if (windows !== undefined) return windows
      return [{
        pageTargetId: PAGE.id,
        pageTitle: PAGE.title,
        page: PAGE,
        currentSessionId,
        readError: null,
        pane: state.pane,
      }]
    },
    async connect() {
      return session
    },
    async evaluate(_session, expression) {
      state.evaluates.push(expression)
      return JSON.stringify({ url: state.pane?.url ?? 'about:blank', title: 'Example', ready: 'complete' })
    },
    async openPaneInWindow(page, url) {
      state.openCalls.push({ page, url })
      if (state.pane === null) state.pane = PANE
      return { windowTargetId: page.id, url: url ?? null }
    },
    async pressKey() {},
    async sleep() {
      state.sleeps += 1
    },
    async openInSystemBrowser() {},
  }
  const tools = createTools({ ctx: fakeCtx(workspaces), endpoint: 'http://127.0.0.1:9222', cdp })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  return { state, session, tool: (name) => byName[name] }
}

const navigations = (session) => session.calls.filter((call) => call.method === 'Page.navigate')

test('browser_open passes its url through to the pane opener', async () => {
  const h = harness()
  const output = await h.tool('browser_open').execute({ url: 'https://example.com' }, EXEC)

  assert.equal(h.state.openCalls.length, 1)
  assert.equal(h.state.openCalls[0].page, PAGE)
  assert.equal(h.state.openCalls[0].url, 'https://example.com')
  assert.equal(h.state.evaluates.length, 1)
  assert.match(output, /Pane pane-1/)
})

test('a freshly opened pane is not navigated twice', async () => {
  const h = harness()
  await h.tool('browser_open').execute({ url: 'https://example.com' }, EXEC)

  assert.equal(h.state.openCalls.length, 1)
  assert.equal(navigations(h.session).length, 0)
})

test('browser_open navigates a reused pane once', async () => {
  const h = harness({ pane: PANE })
  await h.tool('browser_open').execute({ url: 'https://example.com/page' }, EXEC)

  assert.equal(h.state.openCalls.length, 0)
  assert.deepEqual(navigations(h.session).map((call) => call.params.url), ['https://example.com/page'])
})

test('browser_open without a url reuses an existing pane', async () => {
  const h = harness({ pane: PANE })
  const output = await h.tool('browser_open').execute({}, EXEC)

  assert.equal(h.state.openCalls.length, 0)
  assert.equal(navigations(h.session).length, 0)
  assert.equal(h.state.evaluates.length, 1)
  assert.match(output, /Pane pane-1/)
})

test('a tool without a url fails fast when the caller window has no pane', async () => {
  const h = harness()
  const expected = /no browser pane is open in this window; call browser_open with an HTTP\(S\) url first/

  await assert.rejects(h.tool('browser_snapshot').execute({}, EXEC), expected)
  await assert.rejects(h.tool('browser_open').execute({}, EXEC), expected)
  assert.equal(h.state.openCalls.length, 0)
  assert.equal(h.state.sleeps, 0)
})

test('browser_navigate lets a fresh pane load the url through the address bar', async () => {
  const h = harness()
  const output = await h.tool('browser_navigate').execute({ url: 'https://example.com/nav' }, EXEC)

  assert.equal(h.state.openCalls.length, 1)
  assert.equal(h.state.openCalls[0].url, 'https://example.com/nav')
  assert.equal(navigations(h.session).length, 0)
  assert.match(output, /Navigated pane-1/)
})

test('browser_navigate loads a reused pane through Page.navigate', async () => {
  const h = harness({ pane: PANE })
  await h.tool('browser_navigate').execute({ url: 'https://example.com/nav2' }, EXEC)

  assert.equal(h.state.openCalls.length, 0)
  assert.deepEqual(navigations(h.session).map((call) => call.params.url), ['https://example.com/nav2'])
})

test('a session of another workspace drives the pane its window already hosts', async () => {
  // Workspace A opened pane-1; the user switched the window to workspace B's session.
  const h = harness({
    windows: [windowRecord({ id: 'window-1', sessionId: 'session-b', paneId: 'pane-1' })],
  })
  const execB = { agent: { session: { id: 'session-b' } } }

  const output = await h.tool('browser_snapshot').execute({}, execB)

  assert.equal(h.state.openCalls.length, 0)
  assert.equal(h.state.evaluates.length, 1)
  assert.match(output, /"url"/)
})

test('handover snapshots cookies to the calling workspace only', async () => {
  const wsA = { id: 'handover-cookie-a', path: '/handover-cookie-a', sessionIds: ['session-ha'] }
  const wsB = { id: 'handover-cookie-b', path: '/handover-cookie-b', sessionIds: ['session-hb'] }
  const h = harness({
    windows: [windowRecord({ id: 'window-1', sessionId: 'session-hb', paneId: 'pane-1' })],
    workspaces: [wsA, wsB],
    cookies: [cookie('sid', 'from-b')],
  })
  const execB = { agent: { session: { id: 'session-hb' } } }

  await h.tool('browser_snapshot').execute({}, execB)

  assert.deepEqual(await loadCookies(wsB), [cookie('sid', 'from-b')])
  assert.deepEqual(await loadCookies(wsA), [])
})

test('restore injects the calling workspace\'s cookies into the window pane', async () => {
  const workspace = { id: 'restore-caller-ws', path: '/restore-caller-ws', sessionIds: ['session-rc'] }
  await saveCookies(workspace, [cookie('sid', 'restore-me')])
  const h = harness({
    windows: [windowRecord({ id: 'window-1', sessionId: 'session-rc', paneId: 'pane-1' })],
    workspaces: [workspace],
    cookies: [],
  })
  const exec = { agent: { session: { id: 'session-rc' } } }

  await h.tool('browser_snapshot').execute({}, exec)

  const setCookies = h.session.calls.find((call) => call.method === 'Network.setCookies')
  assert.ok(setCookies)
  assert.deepEqual(setCookies.params.cookies, [cookie('sid', 'restore-me')])
})

test('an explicit targetId hosted by another window is refused', async () => {
  const h = harness({
    windows: [
      windowRecord({ id: 'window-1', sessionId: 'session-a', paneId: 'pane-1' }),
      windowRecord({ id: 'window-2', sessionId: 'session-b', paneId: 'pane-2', title: 'Other — DeepSeek Harness' }),
    ],
  })

  await assert.rejects(
    h.tool('browser_snapshot').execute({ targetId: 'pane-2' }, EXEC),
    /CDP target pane-2 is not the pane of the window showing this session; call browser_targets to list targets/,
  )
  assert.equal(h.state.evaluates.length, 0)
})

test('an explicit targetId naming the caller window pane is accepted', async () => {
  const h = harness({
    windows: [
      windowRecord({ id: 'window-1', sessionId: 'session-a', paneId: 'pane-1' }),
      windowRecord({ id: 'window-2', sessionId: 'session-b', paneId: 'pane-2', title: 'Other — DeepSeek Harness' }),
    ],
  })

  await h.tool('browser_snapshot').execute({ targetId: 'pane-1' }, EXEC)

  assert.equal(h.state.evaluates.length, 1)
})
