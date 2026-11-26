import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import {
  CAPTURE_PROBE_TIMEOUT_MS,
  parseCurrentSession,
  parseVisiblePaneUrl,
  parseWindowShell,
  probeCaptureCompletion,
  readWindows,
  selectPane,
  WINDOW_SHELL_SCRIPT,
} from '../lib/windows.js'

const PLACEHOLDER = 'Enter an HTTP(S) address'

/** Stub `<input>` carrying only what the address-bar script reads. */
function stubInput(width, value) {
  return {
    placeholder: PLACEHOLDER,
    value,
    getBoundingClientRect: () => ({ width }),
  }
}

/** Stub restore-screen affordance carrying only what the shell script reads. */
function stubRestore({ width = 120, height = 28, text = 'Restore page' } = {}) {
  return {
    textContent: text,
    getBoundingClientRect: () => ({ width, height }),
  }
}

/** Evaluate the exported shell script against stub inputs and localStorage. */
function runShell({ current = null, inputs = [], restore = [] } = {}) {
  const document = {
    querySelectorAll: (selector) => (selector === 'input' ? inputs : restore),
  }
  const localStorage = { getItem: (key) => (key === 'dsh.sessions.current' ? current : null) }
  return JSON.parse(vm.runInNewContext(WINDOW_SHELL_SCRIPT, { document, localStorage }))
}

test('parseCurrentSession reads the session bridge value', () => {
  assert.equal(parseCurrentSession('{"sessionId":"session-1"}'), 'session-1')
  assert.equal(parseCurrentSession('{"sessionId":" session-2 "}'), 'session-2')
})

test('parseCurrentSession rejects unusable values', () => {
  assert.equal(parseCurrentSession('{"sessionId":""}'), null)
  assert.equal(parseCurrentSession('{"sessionId":"   "}'), null)
  assert.equal(parseCurrentSession('{"sessionId":42}'), null)
  assert.equal(parseCurrentSession('{"other":true}'), null)
  assert.equal(parseCurrentSession('not json'), null)
  assert.equal(parseCurrentSession('null'), null)
  assert.equal(parseCurrentSession(null), null)
  assert.equal(parseCurrentSession(undefined), null)
  assert.equal(parseCurrentSession(42), null)
})

test('window shell returns the visible address-bar value with the session id', () => {
  // The reported live layout: hidden view's bar first, visible one second.
  const parsed = runShell({
    current: '{"sessionId":"session-1"}',
    inputs: [stubInput(0, 'https://hidden.example/'), stubInput(435.5, 'https://visible.example/')],
  })
  assert.deepEqual(parsed, {
    current: '{"sessionId":"session-1"}',
    address: 'https://visible.example/',
    restoring: false,
  })
})

test('window shell reports a visible Restore page screen', () => {
  const parsed = runShell({
    current: '{"sessionId":"session-1"}',
    inputs: [stubInput(435.5, 'https://example.org/')],
    restore: [stubRestore()],
  })
  assert.equal(parsed.restoring, true)
  assert.equal(parsed.address, 'https://example.org/')
})

test('window shell ignores hidden or inexact Restore page affordances', () => {
  assert.equal(runShell({ restore: [stubRestore({ width: 0 })] }).restoring, false)
  assert.equal(runShell({ restore: [stubRestore({ height: 0 })] }).restoring, false)
  assert.equal(runShell({ restore: [stubRestore({ text: 'Restore page now' })] }).restoring, false)
  assert.equal(runShell({ restore: [stubRestore({ text: 'Restore' })] }).restoring, false)
  assert.equal(runShell({ restore: [stubRestore({ text: '  Restore page  ' })] }).restoring, true)
})

test('window shell skips hidden-only address bars', () => {
  const parsed = runShell({ inputs: [stubInput(0, 'https://hidden.example/')] })
  assert.equal(parsed.address, null)
})

test('window shell keeps an empty visible bar empty', () => {
  const parsed = runShell({ inputs: [stubInput(300, '')] })
  assert.equal(parsed.address, '')
})

test('parseWindowShell maps an empty bar to a null visible URL', () => {
  assert.deepEqual(parseWindowShell({ current: '{"sessionId":"s1"}', address: '' }), {
    currentSessionId: 's1',
    visiblePaneUrl: null,
    restoring: false,
  })
  assert.deepEqual(parseWindowShell('{"current":"{\\"sessionId\\":\\"s1\\"}","address":"https://x.test/"}'), {
    currentSessionId: 's1',
    visiblePaneUrl: 'https://x.test/',
    restoring: false,
  })
  assert.deepEqual(parseWindowShell('not json'), {
    currentSessionId: null,
    visiblePaneUrl: null,
    restoring: false,
  })
})

test('parseWindowShell reports the restore screen only for a true flag', () => {
  assert.equal(parseWindowShell({ current: null, address: 'https://x.test/', restoring: true }).restoring, true)
  assert.equal(parseWindowShell({ restoring: 'true' }).restoring, false)
  assert.equal(parseWindowShell({ restoring: 1 }).restoring, false)
  assert.equal(parseWindowShell(null).restoring, false)
})

test('parseVisiblePaneUrl trims and rejects empty values', () => {
  assert.equal(parseVisiblePaneUrl(' https://x.test/ '), 'https://x.test/')
  assert.equal(parseVisiblePaneUrl(''), null)
  assert.equal(parseVisiblePaneUrl('   '), null)
  assert.equal(parseVisiblePaneUrl(null), null)
  assert.equal(parseVisiblePaneUrl(42), null)
})

const PAGE = { id: 'window-1', type: 'page', title: 'Session — DeepSeek Harness' }
const HIDDEN = { id: 'pane-hidden', type: 'webview', parentId: 'window-1', url: 'https://hidden.example/' }
const VISIBLE = { id: 'pane-visible', type: 'webview', parentId: 'window-1', url: 'https://visible.example/docs' }

/** Injectable shell reads: one evaluate per window, keyed by page target id. */
function shellDeps(shells) {
  const evaluated = []
  return {
    evaluated,
    deps: {
      async connect(page) {
        return { targetId: page.id, close() {} }
      },
      async evaluate(session) {
        evaluated.push(session.targetId)
        return JSON.stringify(shells[session.targetId] ?? {})
      },
    },
  }
}

test('readWindows picks the URL-matched webview, not the first one', async () => {
  const { deps, evaluated } = shellDeps({
    'window-1': { current: '{"sessionId":"session-1"}', address: 'https://visible.example/docs/' },
  })

  const windows = await readWindows([PAGE, HIDDEN, VISIBLE], deps)

  assert.deepEqual(evaluated, ['window-1'])
  assert.equal(windows[0].currentSessionId, 'session-1')
  assert.equal(windows[0].visiblePaneUrl, 'https://visible.example/docs/')
  assert.equal(windows[0].views.length, 2)
  assert.equal(windows[0].pane.id, 'pane-visible')
})

test('readWindows has no first-webview fallback when the visible bar matches no view', async () => {
  const { deps } = shellDeps({
    'window-1': { current: '{"sessionId":"session-1"}', address: 'https://elsewhere.example/' },
  })

  const windows = await readWindows([PAGE, HIDDEN, VISIBLE], deps)

  assert.equal(windows[0].visiblePaneUrl, 'https://elsewhere.example/')
  assert.equal(windows[0].pane, null)
})

test('readWindows reports a restore screen (bar value, no webview) as no pane', async () => {
  const { deps } = shellDeps({
    'window-1': { current: '{"sessionId":"session-1"}', address: 'https://portal.example/user-portal' },
  })

  const windows = await readWindows([PAGE], deps)

  assert.equal(windows[0].visiblePaneUrl, 'https://portal.example/user-portal')
  assert.equal(windows[0].views.length, 0)
  assert.equal(windows[0].pane, null)
  assert.equal(windows[0].restoring, false)
})

test('readWindows reports the restore screen and ignores a coincidental URL match', async () => {
  // Live dead end: the stale bar equals another view's live webview URL.
  const stale = 'https://example.org/'
  const coincidental = { id: 'pane-hidden', type: 'webview', parentId: 'window-1', url: stale }
  const { deps } = shellDeps({
    'window-1': { current: '{"sessionId":"session-1"}', address: stale, restoring: true },
  })

  const windows = await readWindows([PAGE, coincidental], deps)

  assert.equal(windows[0].restoring, true)
  assert.equal(windows[0].visiblePaneUrl, stale)
  assert.equal(windows[0].views.length, 1)
  assert.equal(windows[0].pane, null)
})

test('readWindows without a restore screen still matches that same URL', async () => {
  const stale = 'https://example.org/'
  const coincidental = { id: 'pane-hidden', type: 'webview', parentId: 'window-1', url: stale }
  const { deps } = shellDeps({
    'window-1': { current: '{"sessionId":"session-1"}', address: stale },
  })

  const windows = await readWindows([PAGE, coincidental], deps)

  assert.equal(windows[0].restoring, false)
  assert.equal(windows[0].pane.id, 'pane-hidden')
})

test('readWindows clears the visible URL when only a hidden bar exists', async () => {
  const { deps } = shellDeps({
    'window-1': { current: '{"sessionId":"session-1"}', address: null },
  })

  const windows = await readWindows([PAGE, HIDDEN], deps)

  assert.equal(windows[0].visiblePaneUrl, null)
  assert.equal(windows[0].pane, null)
})

test('readWindows maps an empty visible bar to a null URL', async () => {
  const { deps } = shellDeps({
    'window-1': { current: '{"sessionId":"session-1"}', address: '' },
  })

  const windows = await readWindows([PAGE, HIDDEN], deps)

  assert.equal(windows[0].visiblePaneUrl, null)
  assert.equal(windows[0].pane, null)
})

test('readWindows evaluates once per window and keeps views per window', async () => {
  const second = { id: 'window-2', type: 'page', title: 'Other — DeepSeek Harness' }
  const otherView = { id: 'pane-other', type: 'webview', parentId: 'window-2', url: 'https://other.example/' }
  const { deps, evaluated } = shellDeps({
    'window-1': { current: '{"sessionId":"session-1"}', address: 'https://visible.example/docs' },
    'window-2': { current: '{"sessionId":"session-2"}', address: 'https://other.example/' },
  })

  const windows = await readWindows([PAGE, HIDDEN, VISIBLE, second, otherView], deps)

  assert.deepEqual(evaluated, ['window-1', 'window-2'])
  assert.equal(windows[0].views.length, 2)
  assert.equal(windows[0].pane.id, 'pane-visible')
  assert.equal(windows[1].views.length, 1)
  assert.equal(windows[1].pane.id, 'pane-other')
})

test('readWindows reports a shell read error and chooses no pane', async () => {
  const deps = {
    async connect() {
      throw new Error('CDP target exposes no webSocketDebuggerUrl')
    },
    async evaluate() {
      throw new Error('should not be reached')
    },
  }

  const windows = await readWindows([PAGE, VISIBLE], deps)

  assert.match(windows[0].readError, /no webSocketDebuggerUrl/)
  assert.equal(windows[0].visiblePaneUrl, null)
  assert.equal(windows[0].restoring, false)
  assert.equal(windows[0].pane, null)
})

// --- Capture-completion disambiguation for identical same-URL panes ---

const SAME = 'https://same.example/'
const SAME_VIEWS = [
  { id: 'pane-hidden', type: 'webview', parentId: 'window-1', url: SAME },
  { id: 'pane-visible', type: 'webview', parentId: 'window-1', url: SAME },
]
const SAME_SHELL = { 'window-1': { current: '{"sessionId":"session-1"}', address: SAME } }

/** Probe session double recording its close so leaks are visible. */
function probeSession(id, closed) {
  return { id, close() { closed.push(id) } }
}

/** Resolves after `ms` real milliseconds, so a fake send can win the race. */
const slowSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('CAPTURE_PROBE_TIMEOUT_MS exports the documented 2.5s bound', () => {
  assert.equal(CAPTURE_PROBE_TIMEOUT_MS, 2500)
})

test('probeCaptureCompletion reports a completing 1×1 PNG capture and closes its session', async () => {
  const closed = []
  const sent = []
  const slept = []
  const ok = await probeCaptureCompletion(SAME_VIEWS[1], {
    async connect(view) {
      return probeSession(view.id, closed)
    },
    async send(session, method, params) {
      sent.push({ id: session.id, method, params })
      return { data: 'discarded-image-data' }
    },
    async sleep(ms) {
      slept.push(ms)
      return slowSleep(20)
    },
  })

  assert.equal(ok, true)
  assert.deepEqual(closed, ['pane-visible'])
  assert.deepEqual(sent, [{
    id: 'pane-visible',
    method: 'Page.captureScreenshot',
    params: { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } },
  }])
  assert.deepEqual(slept, [2500])
})

test('probeCaptureCompletion returns false at the cap and still closes the session', async () => {
  const closed = []
  const slept = []
  const ok = await probeCaptureCompletion(SAME_VIEWS[0], {
    async connect(view) {
      return probeSession(view.id, closed)
    },
    send() {
      return new Promise(() => {})
    },
    async sleep(ms) {
      slept.push(ms)
    },
  })

  assert.equal(ok, false)
  assert.deepEqual(slept, [2500])
  assert.deepEqual(closed, ['pane-hidden'])
})

test('probeCaptureCompletion treats a throwing send as no capture and closes', async () => {
  const closed = []
  const ok = await probeCaptureCompletion(SAME_VIEWS[0], {
    async connect(view) {
      return probeSession(view.id, closed)
    },
    send() {
      throw new Error('send exploded')
    },
    sleep() {
      return new Promise(() => {})
    },
  })

  assert.equal(ok, false)
  assert.deepEqual(closed, ['pane-hidden'])
})

test('probeCaptureCompletion treats a rejecting send as no capture and closes', async () => {
  const closed = []
  const ok = await probeCaptureCompletion(SAME_VIEWS[0], {
    async connect(view) {
      return probeSession(view.id, closed)
    },
    send() {
      return Promise.reject(new Error('send rejected'))
    },
    sleep() {
      return new Promise(() => {})
    },
  })

  assert.equal(ok, false)
  assert.deepEqual(closed, ['pane-hidden'])
})

test('probeCaptureCompletion treats a connect error as no capture', async () => {
  let sends = 0
  const ok = await probeCaptureCompletion(SAME_VIEWS[0], {
    async connect() {
      throw new Error('no socket')
    },
    send() {
      sends += 1
      return {}
    },
    sleep() {
      return new Promise(() => {})
    },
  })

  assert.equal(ok, false)
  assert.equal(sends, 0)
})

test('selectPane chooses a sole URL match without probing', async () => {
  let connects = 0
  const selection = await selectPane([VISIBLE], 'https://visible.example/docs/', {
    async connect() {
      connects += 1
      return { close() {} }
    },
    async send() {
      return {}
    },
    async sleep() {},
  })

  assert.equal(selection.pane.id, 'pane-visible')
  assert.equal(selection.paneError, null)
  assert.equal(selection.paneErrorMessage, null)
  assert.equal(connects, 0)
})

test('selectPane reports no pane and no error when no webview matches the bar', async () => {
  let connects = 0
  const selection = await selectPane(SAME_VIEWS, 'https://other.example/', {
    async connect() {
      connects += 1
      return { close() {} }
    },
    async send() {
      return {}
    },
    async sleep() {},
  })

  assert.equal(selection.pane, null)
  assert.equal(selection.paneError, null)
  assert.equal(connects, 0)
})

test('selectPane picks the one same-URL pane whose capture completes', async () => {
  const closed = []
  const selection = await selectPane(SAME_VIEWS, SAME, {
    async connect(view) {
      return probeSession(view.id, closed)
    },
    send(session) {
      return session.id === 'pane-visible'
        ? Promise.resolve({ data: 'discarded' })
        : new Promise(() => {})
    },
    sleep() {
      return slowSleep(10)
    },
  })

  assert.equal(selection.pane.id, 'pane-visible')
  assert.equal(selection.paneError, null)
  assert.deepEqual(closed.sort(), ['pane-hidden', 'pane-visible'])
})

test('selectPane reports no-capture when no same-URL pane completes, never a guess', async () => {
  const selection = await selectPane(SAME_VIEWS, SAME, {
    async connect(view) {
      return probeSession(view.id, [])
    },
    send() {
      return new Promise(() => {})
    },
    async sleep() {},
  })

  assert.equal(selection.pane, null)
  assert.equal(selection.paneError, 'no-capture')
  assert.match(selection.paneErrorMessage, /could not identify the browser pane visible in this session's view/)
  assert.match(selection.paneErrorMessage, /bring this session's DSH window to the front and retry/)
  assert.doesNotMatch(selection.paneErrorMessage, /call browser_open/)
})

test('selectPane reports ambiguous when several same-URL panes complete', async () => {
  const selection = await selectPane(SAME_VIEWS, SAME, {
    async connect(view) {
      return probeSession(view.id, [])
    },
    async send() {
      return { data: 'discarded' }
    },
    sleep() {
      return new Promise(() => {})
    },
  })

  assert.equal(selection.pane, null)
  assert.equal(selection.paneError, 'ambiguous')
  assert.match(selection.paneErrorMessage, /several same-URL panes completed a frame capture/)
  assert.match(selection.paneErrorMessage, /bring this session's DSH window to the front and retry/)
  assert.doesNotMatch(selection.paneErrorMessage, /call browser_open/)
})

test('selectPane probes same-URL candidates in parallel', async () => {
  // Sequential probing would deadlock on bothConnected; the guard turns that
  // into a failure instead of a hung suite.
  let connected = 0
  let release
  const bothConnected = new Promise((resolve) => { release = resolve })
  const closed = []
  const outcome = await Promise.race([
    selectPane(SAME_VIEWS, SAME, {
      connect(view) {
        connected += 1
        if (connected === 2) release()
        return bothConnected.then(() => probeSession(view.id, closed))
      },
      send(session) {
        return session.id === 'pane-visible'
          ? Promise.resolve({ data: 'discarded' })
          : new Promise(() => {})
      },
      sleep() {
        return slowSleep(10)
      },
    }),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 500)),
  ])

  assert.notEqual(outcome, 'HUNG')
  assert.equal(outcome.pane.id, 'pane-visible')
  assert.deepEqual(closed.sort(), ['pane-hidden', 'pane-visible'])
})

/** Deps for readWindows that serve the shell read and the webview probes. */
function probeShellDeps({ shells, completers = [], closed = [] }) {
  return {
    async connect(target) {
      if (target.type === 'page') return { targetId: target.id, close() {} }
      return probeSession(target.id, closed)
    },
    async evaluate(session) {
      return JSON.stringify(shells[session.targetId] ?? {})
    },
    send(session) {
      return completers.includes(session.id)
        ? Promise.resolve({ data: 'discarded' })
        : new Promise(() => {})
    },
    sleep() {
      return slowSleep(5)
    },
  }
}

test('readWindows disambiguates identical URLs by the completing capture', async () => {
  const windows = await readWindows(
    [PAGE, ...SAME_VIEWS],
    probeShellDeps({ shells: SAME_SHELL, completers: ['pane-visible'] }),
  )

  assert.equal(windows[0].pane.id, 'pane-visible')
  assert.equal(windows[0].paneError, null)
})

test('readWindows reports ambiguous identical URLs instead of the first target', async () => {
  const windows = await readWindows(
    [PAGE, ...SAME_VIEWS],
    probeShellDeps({ shells: SAME_SHELL, completers: ['pane-hidden', 'pane-visible'] }),
  )

  assert.equal(windows[0].pane, null)
  assert.equal(windows[0].paneError, 'ambiguous')
  assert.match(windows[0].paneErrorMessage, /could not identify the browser pane/)
})

test('readWindows reports no-capture when no same-URL pane completes', async () => {
  const windows = await readWindows(
    [PAGE, ...SAME_VIEWS],
    probeShellDeps({ shells: SAME_SHELL }),
  )

  assert.equal(windows[0].pane, null)
  assert.equal(windows[0].paneError, 'no-capture')
  assert.match(windows[0].paneErrorMessage, /bring this session's DSH window to the front and retry/)
})

test('readWindows does not probe a restore screen even when two views share its URL', async () => {
  const closed = []
  const windows = await readWindows(
    [PAGE, ...SAME_VIEWS],
    probeShellDeps({
      shells: { 'window-1': { current: '{"sessionId":"session-1"}', address: SAME, restoring: true } },
      completers: ['pane-visible'],
      closed,
    }),
  )

  assert.equal(windows[0].restoring, true)
  assert.equal(windows[0].pane, null)
  assert.equal(windows[0].paneError, null)
  assert.deepEqual(closed, [])
})

test('readWindows does not probe a sole URL match', async () => {
  let probeConnects = 0
  const windows = await readWindows([PAGE, HIDDEN, VISIBLE], {
    async connect(target) {
      if (target.type === 'page') return { targetId: target.id, close() {} }
      probeConnects += 1
      return { id: target.id, close() {} }
    },
    async evaluate() {
      return JSON.stringify({ current: '{"sessionId":"session-1"}', address: 'https://visible.example/docs/' })
    },
    send() {
      return Promise.resolve({ data: 'discarded' })
    },
    sleep() {
      return new Promise(() => {})
    },
  })

  assert.equal(windows[0].pane.id, 'pane-visible')
  assert.equal(probeConnects, 0)
})

test('readWindows with probe:false leaves same-URL ambiguity unidentified without probing', async () => {
  let probeConnects = 0
  const closed = []
  const windows = await readWindows(
    [PAGE, ...SAME_VIEWS],
    {
      async connect(target) {
        if (target.type === 'page') return { targetId: target.id, close() {} }
        probeConnects += 1
        return probeSession(target.id, closed)
      },
      async evaluate() {
        return JSON.stringify(SAME_SHELL['window-1'])
      },
      send() {
        throw new Error('probe send must not be reached')
      },
      sleep() {
        throw new Error('probe sleep must not be reached')
      },
    },
    { probe: false },
  )

  assert.equal(probeConnects, 0)
  assert.deepEqual(closed, [])
  assert.equal(windows[0].pane, null)
  assert.equal(windows[0].paneError, null)
  assert.equal(windows[0].paneErrorMessage, null)
  assert.equal(windows[0].visiblePaneUrl, SAME)
  assert.equal(windows[0].views.length, 2)
})

test('readWindows with an explicit probe:true still disambiguates identical URLs', async () => {
  const windows = await readWindows(
    [PAGE, ...SAME_VIEWS],
    probeShellDeps({ shells: SAME_SHELL, completers: ['pane-visible'] }),
    { probe: true },
  )

  assert.equal(windows[0].pane.id, 'pane-visible')
  assert.equal(windows[0].paneError, null)
})
