import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCurrentSession } from '../lib/windows.js'

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
