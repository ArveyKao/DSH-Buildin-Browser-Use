import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { ADDRESS_BAR, openPaneInWindow, RESTORE_SCREEN } from '../lib/ops.js'

// DSH keeps one pane UI mounted per workspace view. After cross-workspace use
// the shell DOM holds several `Enter an HTTP(S) address` inputs; hidden pane
// UIs have a 0-width rect. These stubs mirror what the page actually exposes.
const PLACEHOLDER = 'Enter an HTTP(S) address'

/** Stub `<input>` carrying only what the address-bar script reads. */
function stubInput(width, placeholder = PLACEHOLDER) {
  return {
    placeholder,
    getBoundingClientRect: () => ({ width }),
  }
}

/** Stub restore affordance carrying only what the restore script reads. */
function stubRestore({ width = 120, height = 28, text = 'Restore page' } = {}) {
  return {
    textContent: text,
    getBoundingClientRect: () => ({ width, height }),
  }
}

/** Evaluate the exported address-bar script against stub inputs. */
function evaluateAddressBar(inputs) {
  const document = { querySelectorAll: (selector) => (selector === 'input' ? inputs : []) }
  return vm.runInNewContext(ADDRESS_BAR, { document })
}

/** Evaluate the exported restore-screen script against stub affordances. */
function evaluateRestoreScreen(elements) {
  const document = { querySelectorAll: () => elements }
  return vm.runInNewContext(RESTORE_SCREEN, { document })
}

test('address bar skips a hidden pane UI for the visible one', () => {
  // The reported live layout: hidden input first, visible input second.
  assert.equal(evaluateAddressBar([stubInput(0), stubInput(435.5)]), 'address-bar')
})

test('address bar is null when the only match is hidden', () => {
  assert.equal(evaluateAddressBar([stubInput(0)]), null)
})

test('address bar is null when no input matches the placeholder', () => {
  assert.equal(evaluateAddressBar([stubInput(200, 'Search')]), null)
})

test('address bar is null when nothing is mounted', () => {
  assert.equal(evaluateAddressBar([]), null)
})

test('restore screen detects only a visible exact Restore page affordance', () => {
  assert.equal(evaluateRestoreScreen([stubRestore()]), 'restoring')
  assert.equal(evaluateRestoreScreen([stubRestore({ text: '  Restore page  ' })]), 'restoring')
  assert.equal(evaluateRestoreScreen([stubRestore({ width: 0 }), stubRestore()]), 'restoring')
  assert.equal(evaluateRestoreScreen([stubRestore({ width: 0 })]), null)
  assert.equal(evaluateRestoreScreen([stubRestore({ height: 0 })]), null)
  assert.equal(evaluateRestoreScreen([stubRestore({ text: 'Restore page now' })]), null)
  assert.equal(evaluateRestoreScreen([stubRestore({ text: 'Restore' })]), null)
  assert.equal(evaluateRestoreScreen([]), null)
})

const PAGE = { id: 'window-1', type: 'page', title: 'Session — DeepSeek Harness' }

/**
 * Window shell double for `openPaneInWindow`: a fake CDP session plus an
 * `evaluate` that answers the scripts the opener reads from the page's DOM.
 * A trusted mouseReleased on Restore page spawns the view's own pane.
 */
function fakeShell({ restoring = false, restoreClickWorks = true } = {}) {
  const state = { restoring, calls: [], sleeps: 0, closed: false }
  const session = {
    async send(method, params = {}) {
      state.calls.push({ method, params })
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && restoreClickWorks) {
        state.restoring = false
      }
      return {}
    },
    close() {
      state.closed = true
    },
  }
  const deps = {
    async connect() {
      return session
    },
    async evaluate(_session, expression) {
      if (expression.includes("return 'address-bar'")) return 'address-bar'
      if (expression.includes("'Restore page'")) return state.restoring ? 'restoring' : null
      if (expression.includes('x: Math.round')) return JSON.stringify({ x: 10, y: 20 })
      if (expression.includes("return 'focused'")) return 'focused'
      return null
    },
    async sleep() {
      state.sleeps += 1
    },
  }
  return { state, deps }
}

test('openPaneInWindow clicks Restore page before typing the url', async () => {
  const { state, deps } = fakeShell({ restoring: true })

  await openPaneInWindow(PAGE, 'https://example.com/new', 1000, deps)

  assert.equal(state.closed, true)
  assert.equal(state.restoring, false)
  const methods = state.calls.map((call) => call.method)
  const firstMouse = methods.indexOf('Input.dispatchMouseEvent')
  const inserted = state.calls.findIndex((call) => call.method === 'Input.insertText')
  assert.ok(firstMouse !== -1, 'Restore page was not trusted-clicked')
  assert.ok(inserted !== -1, 'the url was not typed')
  assert.ok(firstMouse < inserted, 'Restore page must be clicked before typing')
  assert.equal(state.calls[inserted].params.text, 'https://example.com/new')
  assert.ok(state.calls.some((call) => call.method === 'Input.dispatchKeyEvent'), 'Enter was not pressed')
})

test('openPaneInWindow restores the pane even without a url', async () => {
  const { state, deps } = fakeShell({ restoring: true })

  await openPaneInWindow(PAGE, undefined, 1000, deps)

  assert.equal(state.restoring, false)
  assert.ok(state.calls.some((call) => call.method === 'Input.dispatchMouseEvent'))
  assert.equal(state.calls.filter((call) => call.method === 'Input.insertText').length, 0)
})

test('openPaneInWindow skips the restore click when no restore screen is mounted', async () => {
  const { state, deps } = fakeShell({ restoring: false })

  await openPaneInWindow(PAGE, 'https://example.com/ready', 1000, deps)

  assert.equal(state.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 0)
  assert.equal(state.calls.filter((call) => call.method === 'Input.insertText').length, 1)
})

test('openPaneInWindow fails when the restore screen never resolves', async () => {
  const { state, deps } = fakeShell({ restoring: true, restoreClickWorks: false })

  await assert.rejects(
    openPaneInWindow(PAGE, 'https://example.com/new', 30, deps),
    /the restored browser pane did not finish restoring/,
  )
  assert.equal(state.closed, true)
  assert.equal(state.calls.filter((call) => call.method === 'Input.insertText').length, 0)
})
