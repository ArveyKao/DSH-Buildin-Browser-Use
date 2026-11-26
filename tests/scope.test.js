import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  chooseWorkspacePane,
  describeTargets,
  sessionTitle,
  windowSessionTitle,
} from '../lib/scope.js'

/** A workspace window record shaped like `readWindows` output. */
function windowRecord({ id = 'window', sessionId = null, paneId = null, title = '' }) {
  return {
    pageTargetId: id,
    pageTitle: title,
    page: { id, type: 'page', title },
    currentSessionId: sessionId,
    readError: null,
    pane: paneId === null ? null : { id: paneId, type: 'webview', url: `https://${paneId}.example/`, title: paneId },
  }
}

test('chooseWorkspacePane prefers the caller window pane', () => {
  const windows = [
    windowRecord({ id: 'w2', sessionId: 's2', paneId: 'pane-2' }),
    windowRecord({ id: 'w1', sessionId: 's1', paneId: 'pane-1' }),
  ]
  const choice = chooseWorkspacePane(windows, { sessionIds: ['s1', 's2'], callerSessionId: 's1' })
  assert.equal(choice.chosen.id, 'pane-1')
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
  assert.equal(choice.matchedBy, 'session-id')
})

test('chooseWorkspacePane shares a pane from another window of the same workspace', () => {
  const windows = [
    windowRecord({ id: 'w1', sessionId: 's1' }),
    windowRecord({ id: 'w2', sessionId: 's2', paneId: 'pane-2' }),
  ]
  const choice = chooseWorkspacePane(windows, { sessionIds: ['s1', 's2'], callerSessionId: 's1' })
  assert.equal(choice.chosen.id, 'pane-2')
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
  assert.equal(choice.matchedBy, 'session-id')
})

test('chooseWorkspacePane reports no pane and a host window when the workspace has none', () => {
  const windows = [windowRecord({ id: 'w1', sessionId: 's1' })]
  const choice = chooseWorkspacePane(windows, { sessionIds: ['s1'], callerSessionId: 's1' })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
  assert.match(choice.reason, /no browser pane/)
})

test('chooseWorkspacePane picks a host window of the workspace when the caller is not displayed', () => {
  const windows = [windowRecord({ id: 'w2', sessionId: 's2' })]
  const choice = chooseWorkspacePane(windows, { sessionIds: ['s1', 's2'], callerSessionId: 's1' })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow.pageTargetId, 'w2')
})

test('chooseWorkspacePane never chooses a pane from another workspace', () => {
  const windows = [
    windowRecord({ id: 'w9', sessionId: 'other-1', paneId: 'pane-9' }),
    windowRecord({ id: 'w1', sessionId: 's1' }),
  ]
  const choice = chooseWorkspacePane(windows, { sessionIds: ['s1'], callerSessionId: 's1' })
  assert.equal(choice.chosen, null)
  assert.equal(choice.callerWindow.pageTargetId, 'w1')
})

test('chooseWorkspacePane falls back to title matching when no session id is readable', () => {
  const windows = [
    windowRecord({ id: 'w1', sessionId: null, paneId: 'pane-1', title: 'Docs — DeepSeek Harness' }),
  ]
  const choice = chooseWorkspacePane(windows, {
    sessionIds: ['s1'],
    callerSessionId: 's1',
    titles: { s1: 'Docs' },
  })
  assert.equal(choice.chosen.id, 'pane-1')
  assert.equal(choice.matchedBy, 'title')
})

test('chooseWorkspacePane does not fall back to titles while any session id is readable', () => {
  const windows = [
    windowRecord({ id: 'w9', sessionId: 'other-1' }),
    windowRecord({ id: 'w1', sessionId: null, paneId: 'pane-1', title: 'Docs — DeepSeek Harness' }),
  ]
  const choice = chooseWorkspacePane(windows, {
    sessionIds: ['s1'],
    callerSessionId: 's1',
    titles: { s1: 'Docs' },
  })
  assert.equal(choice.chosen, null)
})

test('chooseWorkspacePane ignores title matches from another workspace title', () => {
  const windows = [
    windowRecord({ id: 'w1', sessionId: null, paneId: 'pane-1', title: 'Other — DeepSeek Harness' }),
  ]
  const choice = chooseWorkspacePane(windows, {
    sessionIds: ['s1'],
    callerSessionId: 's1',
    titles: { s1: 'Docs' },
  })
  assert.equal(choice.chosen, null)
  assert.equal(choice.matchedBy, 'title')
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
