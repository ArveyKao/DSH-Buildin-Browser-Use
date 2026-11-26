import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import {
  parseCurrentSession,
  parseVisiblePaneUrl,
  parseWindowShell,
  readWindows,
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
