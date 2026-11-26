import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTools } from '../index.js'
import { matchVisiblePane } from '../lib/scope.js'
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

/** One webview target in a window. */
function view(id, { parentId = 'window-1', url = `https://${id}.example/` } = {}) {
  const target = { id, type: 'webview', parentId, url }
  return target
}

/** A window record shaped like `readWindows` output. */
function windowRecord({
  id = 'window-1',
  sessionId = 'session-a',
  title = 'Session — DeepSeek Harness',
  views,
  visiblePaneUrl,
  paneId = null,
  restoring = false,
  paneError = null,
  paneErrorMessage = null,
} = {}) {
  let allViews = views
  if (allViews === undefined) {
    allViews = paneId === null ? [] : [view(paneId, { parentId: id })]
  }
  if (visiblePaneUrl === undefined) {
    visiblePaneUrl = allViews.length === 1 ? allViews[0].url : null
  }
  return {
    pageTargetId: id,
    pageTitle: title,
    page: { id, type: 'page', title },
    currentSessionId: sessionId,
    visiblePaneUrl,
    restoring,
    readError: null,
    views: allViews,
    pane: matchVisiblePane(allViews, visiblePaneUrl),
    paneError,
    paneErrorMessage,
  }
}

/** Clone a window so one test's fake opens do not leak into shared fixtures. */
function cloneWindow(win) {
  return { ...win, views: win.views.map((candidate) => ({ ...candidate })) }
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
      if (method === 'Page.captureScreenshot' && state.hangScreenshot) return new Promise(() => {})
      return {}
    },
    close() {
      this.closed = true
    },
  }
}

/** Add a freshly spawned webview with a unique `pane-N` id. */
function spawnPane(state, win, url) {
  const known = new Set(state.windows.flatMap((candidate) => candidate.views.map((v) => v.id)))
  let n = 1
  while (known.has(`pane-${n}`)) n += 1
  const target = { id: `pane-${n}`, type: 'webview', parentId: win.pageTargetId, url }
  win.views.push(target)
  return target
}

/**
 * Tool set wired to fake CDP operations. Each window holds every webview its
 * session views spawned; `visiblePaneUrl` is the visible address bar. Opening
 * through the visible bar navigates the pane that bar already shows, or spawns
 * a new webview for the visible view, mirroring DSH.
 */
function harness({
  pane = null,
  currentSessionId = 'session-a',
  windows,
  workspaces,
  cookies = [],
  openPane,
  hangScreenshot = false,
} = {}) {
  const state = {
    windows: windows !== undefined
      ? windows.map(cloneWindow)
      : [windowRecord({
          views: pane === null ? [] : [pane],
          visiblePaneUrl: pane?.url ?? null,
          sessionId: currentSessionId,
        })],
    openCalls: [],
    sleeps: 0,
    evaluates: [],
    connectedTargets: [],
    cookies,
    hangScreenshot,
  }
  const session = fakeSession(state)
  const cdp = {
    async fetchTargets() {
      return state.windows.flatMap((win) => [win.page, ...win.views])
    },
    async readWindows() {
      return state.windows.map((win) => ({
        ...win,
        pane: win.restoring === true ? null : matchVisiblePane(win.views, win.visiblePaneUrl),
      }))
    },
    async connect(target) {
      state.connectedTargets.push(target)
      return session
    },
    async evaluate(_session, expression) {
      state.evaluates.push(expression)
      const target = state.connectedTargets[state.connectedTargets.length - 1]
      return JSON.stringify({ url: target?.url ?? 'about:blank', title: 'Example', ready: 'complete' })
    },
    async openPaneInWindow(page, url) {
      state.openCalls.push({ page, url })
      const win = state.windows.find((candidate) => candidate.pageTargetId === page.id)
      if (win !== undefined) {
        if (openPane !== undefined) {
          openPane({ state, win, url })
        } else if (win.restoring === true) {
          // The trusted Restore page click spawns this view's own webview.
          spawnPane(state, win, url ?? win.visiblePaneUrl)
          win.restoring = false
          if (url !== undefined) win.visiblePaneUrl = url
        } else {
          const visible = matchVisiblePane(win.views, win.visiblePaneUrl)
          if (visible !== null && url !== undefined) visible.url = url
          else if (url !== undefined) spawnPane(state, win, url)
          if (url !== undefined) win.visiblePaneUrl = url
        }
      }
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
  assert.equal(h.state.openCalls[0].page.id, PAGE.id)
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

test('a tool without a url fails fast when the caller view has no visible pane', async () => {
  const h = harness()
  const expected = /no browser pane is visible in this session's view; call browser_open with an HTTP\(S\) url first/

  await assert.rejects(h.tool('browser_snapshot').execute({}, EXEC), expected)
  await assert.rejects(h.tool('browser_open').execute({}, EXEC), expected)
  assert.equal(h.state.openCalls.length, 0)
  assert.equal(h.state.sleeps, 0)
})

const AMBIGUOUS_MESSAGE = "could not identify the browser pane visible in this session's view: several same-URL panes completed a frame capture; bring this session's DSH window to the front and retry"

test('an unidentifiable same-URL pane fails clearly, without the browser_open retry hint', async () => {
  const h = harness({
    windows: [windowRecord({
      views: [],
      visiblePaneUrl: 'https://same.example/',
      paneError: 'ambiguous',
      paneErrorMessage: AMBIGUOUS_MESSAGE,
    })],
  })

  await assert.rejects(h.tool('browser_snapshot').execute({}, EXEC), (error) => {
    assert.equal(error.message, AMBIGUOUS_MESSAGE)
    assert.doesNotMatch(error.message, /call browser_open/)
    return true
  })
  // browser_open cannot resolve an ambiguity: it must fail before the opener.
  await assert.rejects(h.tool('browser_open').execute({ url: 'https://same.example/' }, EXEC), (error) => {
    assert.equal(error.message, AMBIGUOUS_MESSAGE)
    assert.doesNotMatch(error.message, /call browser_open/)
    return true
  })
  assert.equal(h.state.openCalls.length, 0)
  assert.equal(h.state.connectedTargets.length, 0)
})

test('browser_targets and browser_scope_probe report the pane error kind', async () => {
  const h = harness({
    windows: [windowRecord({
      views: [],
      visiblePaneUrl: 'https://same.example/',
      paneError: 'no-capture',
      paneErrorMessage: "could not identify the browser pane visible in this session's view",
    })],
  })

  const targets = JSON.parse(await h.tool('browser_targets').execute({}, EXEC))
  assert.equal(targets.windows[0].paneError, 'no-capture')
  assert.equal(targets.windows[0].paneTargetId, null)

  const probe = JSON.parse(await h.tool('browser_scope_probe').execute({}, EXEC))
  assert.equal(probe.paneError, 'no-capture')
  assert.equal(probe.windows[0].paneError, 'no-capture')
  assert.equal(probe.chosenPane, null)
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

test('with two webviews the caller drives the one matching the visible bar, even second', async () => {
  const hidden = view('pane-hidden', { url: 'https://hidden.example/' })
  const mine = view('pane-mine', { url: 'https://mine.example/' })
  const h = harness({
    windows: [windowRecord({ views: [hidden, mine], visiblePaneUrl: 'https://mine.example/' })],
  })

  await h.tool('browser_snapshot').execute({}, EXEC)

  assert.equal(h.state.openCalls.length, 0)
  assert.equal(h.state.connectedTargets.length, 1)
  assert.equal(h.state.connectedTargets[0].id, 'pane-mine')
})

test('browser_open spawns the caller view pane, never a hidden webview showing the same URL', async () => {
  // Live dead end: hidden view shows example.org while the visible view is a
  // restore screen. Opening example.org must spawn the visible pane.
  const hidden = view('pane-1', { url: 'https://example.org/' })
  const h = harness({
    windows: [windowRecord({ views: [hidden], visiblePaneUrl: 'https://portal.example/user-portal' })],
  })

  const output = await h.tool('browser_open').execute({ url: 'https://example.org/' }, EXEC)

  assert.equal(h.state.openCalls.length, 1)
  assert.equal(h.state.openCalls[0].url, 'https://example.org/')
  assert.equal(h.state.connectedTargets[0].id, 'pane-2')
  assert.match(output, /Pane pane-2/)
  const stillHidden = h.state.windows[0].views.find((candidate) => candidate.id === 'pane-1')
  assert.equal(stillHidden.url, 'https://example.org/')
})

test('browser_open returns an existing view whose pane the bar navigated', async () => {
  const existing = view('pane-9', { url: 'https://old.example/' })
  const h = harness({
    windows: [windowRecord({ views: [existing], visiblePaneUrl: 'https://restore.example/' })],
    // DSH can resolve the typed URL onto the view's existing webview without spawning.
    openPane: ({ win, url }) => {
      win.views[0].url = url
      win.visiblePaneUrl = url
    },
  })

  const output = await h.tool('browser_open').execute({ url: 'https://target.example/' }, EXEC)

  assert.equal(h.state.connectedTargets[0].id, 'pane-9')
  assert.match(output, /Pane pane-9/)
})

test('browser_open never accepts an unchanged hidden webview that already shows the URL', async () => {
  const hidden = view('pane-1', { url: 'https://example.org/' })
  const h = harness({
    windows: [windowRecord({ views: [hidden], visiblePaneUrl: 'https://portal.example/user-portal' })],
    // No visible webview spawns and the hidden one does not change.
    openPane: ({ win, url }) => {
      win.visiblePaneUrl = url
    },
  })

  await assert.rejects(
    h.tool('browser_open').execute({ url: 'https://example.org/' }, EXEC),
    /the browser pane opened but no page target appeared/,
  )
  assert.equal(h.state.connectedTargets.length, 0)
})

test('a restored view fails a pane tool fast even when a hidden webview shows the stale url', async () => {
  // Live dead end: the restore screen's stale bar equals another view's webview.
  const stale = 'https://example.org/'
  const hidden = view('pane-1', { url: stale })
  const h = harness({
    windows: [windowRecord({ views: [hidden], visiblePaneUrl: stale, restoring: true })],
  })

  await assert.rejects(
    h.tool('browser_snapshot').execute({}, EXEC),
    /no browser pane is visible in this session's view; call browser_open with an HTTP\(S\) url first/,
  )
  assert.equal(h.state.openCalls.length, 0)
  assert.equal(h.state.connectedTargets.length, 0)
})

test('browser_open in a restored view returns the spawned pane, never the coincidental hidden match', async () => {
  const stale = 'https://example.org/'
  const hidden = view('pane-1', { url: stale })
  const h = harness({
    windows: [windowRecord({ views: [hidden], visiblePaneUrl: stale, restoring: true })],
  })

  const output = await h.tool('browser_open').execute({ url: stale }, EXEC)

  assert.equal(h.state.openCalls.length, 1)
  assert.equal(h.state.connectedTargets[0].id, 'pane-2')
  assert.match(output, /Pane pane-2/)
  assert.equal(h.state.windows[0].restoring, false)
  const untouched = h.state.windows[0].views.find((candidate) => candidate.id === 'pane-1')
  assert.equal(untouched.url, stale)
})

test('a session of another workspace drives the pane its window already shows', async () => {
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

test('per-view calls snapshot cookies to the calling workspace only', async () => {
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

test('restore injects the calling workspace\'s cookies into the visible pane', async () => {
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

test('an explicit targetId naming another window\'s webview is refused', async () => {
  const h = harness({
    windows: [
      windowRecord({ id: 'window-1', sessionId: 'session-a', paneId: 'pane-1' }),
      windowRecord({ id: 'window-2', sessionId: 'session-b', paneId: 'pane-2', title: 'Other — DeepSeek Harness' }),
    ],
  })

  await assert.rejects(
    h.tool('browser_snapshot').execute({ targetId: 'pane-2' }, EXEC),
    /CDP target pane-2 is not this session's browser pane; call browser_targets to list targets/,
  )
  assert.equal(h.state.evaluates.length, 0)
})

test('an explicit targetId naming the window\'s other webview is refused', async () => {
  const mine = view('pane-mine', { url: 'https://mine.example/' })
  const other = view('pane-other', { url: 'https://other.example/' })
  const h = harness({
    windows: [windowRecord({ views: [mine, other], visiblePaneUrl: 'https://mine.example/' })],
  })

  await assert.rejects(
    h.tool('browser_snapshot').execute({ targetId: 'pane-other' }, EXEC),
    /CDP target pane-other is not this session's browser pane; call browser_targets to list targets/,
  )
  assert.equal(h.state.evaluates.length, 0)
})

test('an explicit targetId naming the caller\'s visible pane is accepted', async () => {
  const h = harness({
    windows: [
      windowRecord({ id: 'window-1', sessionId: 'session-a', paneId: 'pane-1' }),
      windowRecord({ id: 'window-2', sessionId: 'session-b', paneId: 'pane-2', title: 'Other — DeepSeek Harness' }),
    ],
  })

  await h.tool('browser_snapshot').execute({ targetId: 'pane-1' }, EXEC)

  assert.equal(h.state.evaluates.length, 1)
  assert.equal(h.state.connectedTargets[0].id, 'pane-1')
})

test('browser_screenshot times out with a clear error when capture never resolves', async () => {
  const h = harness({ pane: PANE, hangScreenshot: true })

  await assert.rejects(
    h.tool('browser_screenshot').execute({}, EXEC),
    /screenshot timed out after 15s; the pane may be hidden — switch to this session in its DSH window and retry/,
  )
  assert.ok(h.session.calls.some((call) => call.method === 'Page.captureScreenshot'))
})

test('browser_targets and browser_scope_probe report the visible pane URL and webview count', async () => {
  const hidden = view('pane-hidden', { url: 'https://hidden.example/' })
  const mine = view('pane-mine', { url: 'https://mine.example/' })
  const h = harness({
    windows: [windowRecord({ views: [hidden, mine], visiblePaneUrl: 'https://mine.example/' })],
  })

  const targets = JSON.parse(await h.tool('browser_targets').execute({}, EXEC))
  assert.equal(targets.windows[0].visiblePaneUrl, 'https://mine.example/')
  assert.equal(targets.windows[0].webviewCount, 2)
  assert.equal(targets.windows[0].restoring, false)
  assert.equal(targets.windows[0].showsCaller, true)
  assert.equal(targets.windows[0].paneTargetId, 'pane-mine')

  const probe = JSON.parse(await h.tool('browser_scope_probe').execute({}, EXEC))
  assert.equal(probe.windows[0].visiblePaneUrl, 'https://mine.example/')
  assert.equal(probe.windows[0].webviewCount, 2)
  assert.equal(probe.windows[0].restoring, false)
  assert.equal(probe.chosenPane.id, 'pane-mine')
})

test('browser_scope_probe reports the restore screen and no chosen pane', async () => {
  const stale = 'https://example.org/'
  const hidden = view('pane-1', { url: stale })
  const h = harness({
    windows: [windowRecord({ views: [hidden], visiblePaneUrl: stale, restoring: true })],
  })

  const probe = JSON.parse(await h.tool('browser_scope_probe').execute({}, EXEC))

  assert.equal(probe.windows[0].restoring, true)
  assert.equal(probe.windows[0].paneTargetId, null)
  assert.equal(probe.chosenPane, null)
  assert.match(probe.reason, /no pane is visible in the caller's session view yet/)
})
