import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTools } from '../index.js'

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
const EXEC = { agent: { session: { id: 'session-1' } } }

function fakeCtx() {
  return {
    get(key) {
      if (key === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws-1', path: '/ws-1', sessionIds: ['session-1', 'session-2'] }] }
      }
      if (key === 'sessions') return { get: () => undefined }
      return undefined
    },
  }
}

/** CDP session double that records every command. */
function fakeSession() {
  const calls = []
  return {
    calls,
    closed: false,
    async send(method, params = {}) {
      calls.push({ method, params })
      if (method === 'Network.getAllCookies') return { cookies: [] }
      return {}
    },
    close() {
      this.closed = true
    },
  }
}

/**
 * Tool set wired to fake CDP operations. `pane` starts as the workspace's
 * existing pane or null; opening one adds `PANE`, mirroring DSH.
 */
function harness({ pane = null } = {}) {
  const state = { pane, openCalls: [], sleeps: 0, evaluates: [] }
  const session = fakeSession()
  const cdp = {
    async fetchTargets() {
      return state.pane === null ? [PAGE] : [PAGE, state.pane]
    },
    async readWindows() {
      return [{
        pageTargetId: PAGE.id,
        pageTitle: PAGE.title,
        page: PAGE,
        currentSessionId: 'session-1',
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
  const tools = createTools({ ctx: fakeCtx(), endpoint: 'http://127.0.0.1:9222', cdp })
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

test('a tool without a url fails fast when the workspace has no pane', async () => {
  const h = harness()
  const expected = /no browser pane is open in this workspace; call browser_open with an HTTP\(S\) url first/

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
