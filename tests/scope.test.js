import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  chooseCallerPane,
  describeTargets,
  matchVisiblePane,
  sessionTitle,
  windowSessionTitle,
} from '../lib/scope.js'

/** A window record shaped like `readWindows` output. */
function windowRecord({ id = 'window', sessionId = null, paneId = null, title = '' }) {
  const pane = paneId === null
    ? null
    : { id: paneId, type: 'webview', parentId: id, url: `https://${paneId}.example/`, title: paneId }
  return {
    pageTargetId: id,
    pageTitle: title,
    page: { id, type: 'page', title },
    currentSessionId: sessionId,
    visiblePaneUrl: pane?.url ?? null,
    readError: null,
    views: pane === null ? [] : [pane],
    pane,
  }
}

test('matchVisiblePane matches a URL across trailing-slash and host-case differences', () => {
  const views = [
    { id: 'pane-a', type: 'webview', parentId: 'window', url: 'https://example.org/docs/' },
    { id: 'pane-b', type: 'webview', parentId: 'window', url: 'https://EXAMPLE.org/Other' },
  ]
  assert.equal(matchVisiblePane(views, 'https://example.org/docs').id, 'pane-a')
  assert.equal(matchVisiblePane(views, 'https://example.org/docs/').id, 'pane-a')
  assert.equal(matchVisiblePane(views, 'https://example.org/Other').id, 'pane-b')
})

test('matchVisiblePane keeps the root path slash insignificant', () => {
  const views = [{ id: 'pane-a', type: 'webview', parentId: 'window', url: 'https://example.org/' }]
  assert.equal(matchVisiblePane(views, 'https://example.org').id, 'pane-a')
  assert.equal(matchVisiblePane(views, 'https://example.org/').id, 'pane-a')
})

test('matchVisiblePane requires search params to match', () => {
  const views = [{ id: 'pane-a', type: 'webview', parentId: 'window', url: 'https://x.test/search?q=a' }]
  assert.equal(matchVisiblePane(views, 'https://x.test/search?q=a').id, 'pane-a')
  assert.equal(matchVisiblePane(views, 'https://x.test/search?q=b'), null)
  assert.equal(matchVisiblePane(views, 'https://x.test/search'), null)
})

test('matchVisiblePane returns the first matching view and null on misses', () => {
  const views = [
    { id: 'pane-a', type: 'webview', parentId: 'window', url: 'https://x.test/same' },
    { id: 'pane-b', type: 'webview', parentId: 'window', url: 'https://x.test/same' },
    { id: 'pane-c', type: 'webview', parentId: 'window', url: 'https://x.test/other' },
  ]
  assert.equal(matchVisiblePane(views, 'https://x.test/same').id, 'pane-a')
  assert.equal(matchVisiblePane(views, 'https://x.test/missing'), null)
})

test('matchVisiblePane treats null, empty and invalid URLs as no match', () => {
  const views = [{ id: 'pane-a', type: 'webview', parentId: 'window', url: 'https://x.test/' }]
  assert.equal(matchVisiblePane(views, null), null)
  assert.equal(matchVisiblePane(views, ''), null)
  assert.equal(matchVisiblePane(views, '   '), null)
  assert.equal(matchVisiblePane(views, 'not a url'), null)
  assert.equal(matchVisiblePane([], 'https://x.test/'), null)
  assert.equal(matchVisiblePane([{ id: 'bad', type: 'webview', url: 'nope' }], 'https://x.test/'), null)
})


test('chooseCallerPane chooses the pane of the window showing the caller', () => {
  const windows = [
    windowRecord({ id: 'w2', sessionId: 's2', paneId: 'pane-2' }),
    windowRecord({ id: 'w1', sessionId: 's1', paneId: 'pane-1' }),
  ]
  const choice = chooseCallerPane(windows, { callerSessionId: 's1' })
  assert.equal(choice.chosen.id, 'pane-1')
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
  assert.equal(choice.matchedBy, 'session-id')
  assert.match(choice.reason, /caller's session view/)
})

test('chooseCallerPane reports the caller window when it has no pane yet', () => {
  const windows = [
    windowRecord({ id: 'w2', sessionId: 's2', paneId: 'pane-2' }),
    windowRecord({ id: 'w1', sessionId: 's1' }),
  ]
  const choice = chooseCallerPane(windows, { callerSessionId: 's1' })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
  assert.equal(choice.matchedBy, 'session-id')
  assert.match(choice.reason, /no pane is visible/)
})

test('chooseCallerPane never borrows the pane of another window', () => {
  const windows = [
    windowRecord({ id: 'w2', sessionId: 's2', paneId: 'pane-2' }),
    windowRecord({ id: 'w1', sessionId: 's1' }),
  ]
  const choice = chooseCallerPane(windows, { callerSessionId: 's1' })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
})

test('chooseCallerPane fails clearly when the caller is displayed in no window', () => {
  const windows = [windowRecord({ id: 'w2', sessionId: 's2', paneId: 'pane-2' })]
  const choice = chooseCallerPane(windows, { callerSessionId: 's1', callerTitle: 'Mine' })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow, null)
  assert.equal(choice.matchedBy, 'session-id')
  assert.match(choice.reason, /not displayed in any open window; switch to it in a DSH window first/)
})

test('chooseCallerPane is not filtered by workspace: a window showing the caller hosts its pane', () => {
  // The pane may have been opened by any workspace; the displayed session decides.
  const windows = [
    windowRecord({ id: 'gms-window', sessionId: 'gms-session', paneId: 'pane-gms' }),
    windowRecord({ id: 'shared-window', sessionId: 'yl-session', paneId: 'pane-yle' }),
  ]
  const choice = chooseCallerPane(windows, { callerSessionId: 'yl-session' })
  assert.equal(choice.chosen.id, 'pane-yle')
  assert.equal(choice.callerWindow.pageTargetId, 'shared-window')
  assert.equal(choice.matchedBy, 'session-id')
})

test('chooseCallerPane falls back to the window title only when no session id is readable', () => {
  const windows = [
    windowRecord({ id: 'w1', sessionId: null, paneId: 'pane-1', title: 'Docs — DeepSeek Harness' }),
  ]
  const choice = chooseCallerPane(windows, { callerSessionId: 's1', callerTitle: 'Docs' })
  assert.equal(choice.chosen.id, 'pane-1')
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
  assert.equal(choice.matchedBy, 'title')
})

test('chooseCallerPane title fallback reports a titled window with no pane', () => {
  const windows = [windowRecord({ id: 'w1', sessionId: null, title: 'Docs — DeepSeek Harness' })]
  const choice = chooseCallerPane(windows, { callerSessionId: 's1', titles: { s1: 'Docs' } })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
  assert.equal(choice.matchedBy, 'title')
  assert.match(choice.reason, /no visible pane yet/)
})

test('chooseCallerPane ignores titles while any window yields a session id', () => {
  const windows = [
    windowRecord({ id: 'w2', sessionId: 'other-1' }),
    windowRecord({ id: 'w1', sessionId: null, paneId: 'pane-1', title: 'Docs — DeepSeek Harness' }),
  ]
  const choice = chooseCallerPane(windows, { callerSessionId: 's1', callerTitle: 'Docs' })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow, null)
  assert.equal(choice.matchedBy, 'session-id')
})

test('chooseCallerPane title fallback misses when no window is titled for the caller', () => {
  const windows = [
    windowRecord({ id: 'w1', sessionId: null, paneId: 'pane-1', title: 'Other — DeepSeek Harness' }),
  ]
  const choice = chooseCallerPane(windows, { callerSessionId: 's1', callerTitle: 'Docs' })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow, null)
  assert.equal(choice.matchedBy, 'title')
  assert.match(choice.reason, /not displayed in any open window; switch to it in a DSH window first/)
})

test('windowSessionTitle strips only the product suffix', () => {
  assert.equal(windowSessionTitle('Docs — DeepSeek Harness'), 'Docs')
  assert.equal(windowSessionTitle('A — DeepSeek Harness — DeepSeek Harness'), 'A — DeepSeek Harness')
  assert.equal(windowSessionTitle('Docs'), undefined)
  assert.equal(windowSessionTitle(undefined), undefined)
  assert.equal(windowSessionTitle(42), undefined)
})

test('sessionTitle reads the latest title event', () => {
  const session = {
    events: [
      { type: 'session/title', data: { title: 'Old' } },
      { type: 'message' },
      { type: 'session/title', data: { title: 'New' } },
      { type: 'session/title', data: { title: 42 } },
    ],
  }
  assert.equal(sessionTitle(session), 'New')
  assert.equal(sessionTitle({}), undefined)
  assert.equal(sessionTitle(undefined), undefined)
})

test('describeTargets maps each page to the webview pane it hosts', () => {
  const described = describeTargets([
    { id: 'w1', type: 'page', title: 'Windows', url: 'file://shell' },
    { id: 'p1', type: 'webview', parentId: 'w1', url: 'https://x', title: 'X' },
    { id: 'w2', type: 'page', title: 'Empty', url: 'file://shell2' },
  ])
  assert.deepEqual(described, [
    { id: 'w1', type: 'page', title: 'Windows', url: 'file://shell', parentId: null, hostsPaneOf: 'p1' },
    { id: 'p1', type: 'webview', title: 'X', url: 'https://x', parentId: 'w1', hostsPaneOf: null },
    { id: 'w2', type: 'page', title: 'Empty', url: 'file://shell2', parentId: null, hostsPaneOf: null },
  ])
})
