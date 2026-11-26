import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { ADDRESS_BAR } from '../lib/ops.js'

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

/** Evaluate the exported address-bar script against stub inputs. */
function evaluateAddressBar(inputs) {
  const document = { querySelectorAll: (selector) => (selector === 'input' ? inputs : []) }
  return vm.runInNewContext(ADDRESS_BAR, { document })
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
