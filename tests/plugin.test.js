import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'

test('exports the native Host plugin contract', () => {
  assert.equal(name, 'workspace-browser')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('apply registers the documented tool set without touching CDP', () => {
  const tools = []
  const ctx = {
    get: () => undefined,
    tools: { register: (tool) => { tools.push(tool) } },
  }

  apply(ctx, {})

  assert.deepEqual(tools.map((tool) => tool.name), [
    'browser_targets',
    'browser_scope_probe',
    'browser_open',
    'browser_attach',
    'browser_navigate',
    'browser_open_external',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_evaluate',
    'browser_screenshot',
  ])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
  }
})
