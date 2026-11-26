import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CdpSession,
  clickAt,
  connect,
  evaluate,
  fetchTargets,
  pressKey,
} from '../lib/cdp.js'

/** CDP session double that records sent commands. */
function fakeSession(reply = () => ({})) {
  const calls = []
  return {
    calls,
    async send(method, params = {}) {
      calls.push({ method, params })
      return reply(method, params)
    },
  }
}

/** Minimal WebSocket double for CdpSession. */
class FakeSocket {
  constructor() {
    this.listeners = new Map()
    this.sent = []
    this.closed = false
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.closed = true
    this.emit('close')
  }
}

test('evaluate returns the by-value result', async () => {
  const session = fakeSession(() => ({ result: { value: 42 } }))
  assert.equal(await evaluate(session, '6*7'), 42)
  assert.deepEqual(session.calls[0], {
    method: 'Runtime.evaluate',
    params: { expression: '6*7', returnByValue: true, awaitPromise: true },
  })
})

test('evaluate surfaces page exception details', async () => {
  const session = fakeSession(() => ({
    exceptionDetails: { exception: { description: 'ReferenceError: x is not defined' } },
  }))
  await assert.rejects(evaluate(session, 'x'), /Page evaluation failed: ReferenceError: x is not defined/)
})

test('evaluate falls back to exception text', async () => {
  const session = fakeSession(() => ({ exceptionDetails: { text: 'Uncaught' } }))
  await assert.rejects(evaluate(session, 'throw 1'), /Page evaluation failed: Uncaught/)
})

test('clickAt dispatches move, press and release at the same point', async () => {
  const session = fakeSession()
  await clickAt(session, 10, 20)
  assert.deepEqual(session.calls.map((call) => call.method), [
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
  ])
  assert.deepEqual(session.calls.map((call) => call.params.type), [
    'mouseMoved',
    'mousePressed',
    'mouseReleased',
  ])
  assert.deepEqual(session.calls.map((call) => call.params.buttons), [0, 1, 0])
  for (const call of session.calls) {
    assert.equal(call.params.x, 10)
    assert.equal(call.params.y, 20)
  }
})

test('pressKey sends Enter text only on keyDown', async () => {
  const session = fakeSession()
  await pressKey(session, { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' })
  assert.equal(session.calls.length, 2)
  assert.equal(session.calls[0].params.type, 'keyDown')
  assert.equal(session.calls[0].params.text, '\r')
  assert.equal(session.calls[0].params.windowsVirtualKeyCode, 13)
  assert.equal(session.calls[1].params.type, 'keyUp')
  assert.equal(session.calls[1].params.text, undefined)
})

test('fetchTargets returns the target array', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'http://127.0.0.1:9222/json/list')
    return new Response(JSON.stringify([{ id: 'target-1' }]), { status: 200 })
  })
  assert.deepEqual(await fetchTargets('http://127.0.0.1:9222/'), [{ id: 'target-1' }])
  assert.equal(mock.mock.callCount(), 1)
})

test('fetchTargets explains a missing CDP endpoint', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9222')
  })
  await assert.rejects(
    fetchTargets('http://127.0.0.1:9222'),
    /Cannot reach the CDP endpoint at http:\/\/127\.0\.0\.1:9222 \(connect ECONNREFUSED/,
  )
})

test('fetchTargets rejects HTTP failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('bad gateway', { status: 502 }))
  await assert.rejects(fetchTargets('http://127.0.0.1:9222'), /HTTP 502/)
})

test('fetchTargets rejects a non-array payload', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ targets: [] }), { status: 200 }),
  )
  await assert.rejects(fetchTargets('http://127.0.0.1:9222'), /not an array/)
})

test('connect refuses a target without a debugger URL', async () => {
  await assert.rejects(
    connect({ id: 'target-1', url: 'https://example.com' }),
    /no webSocketDebuggerUrl/,
  )
})

test('CdpSession resolves replies by id', async () => {
  const socket = new FakeSocket()
  const session = new CdpSession('target-1', socket)
  const reply = session.send('Runtime.evaluate', { expression: '1' })
  assert.deepEqual(socket.sent[0], {
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
  })
  socket.emit('message', { data: JSON.stringify({ id: 1, result: { value: 1 } }) })
  assert.deepEqual(await reply, { value: 1 })
})

test('CdpSession rejects CDP errors', async () => {
  const socket = new FakeSocket()
  const session = new CdpSession('target-1', socket)
  const reply = session.send('NoSuch.method')
  socket.emit('message', {
    data: JSON.stringify({ id: 1, error: { message: "NoSuch.method wasn't found", code: -32601 } }),
  })
  await assert.rejects(reply, /NoSuch\.method wasn't found \(-32601\)/)
})

test('CdpSession ignores malformed messages and notifications', () => {
  const socket = new FakeSocket()
  new CdpSession('target-1', socket)
  socket.emit('message', { data: 'not json' })
  socket.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired' }) })
  socket.emit('message', { data: JSON.stringify({ id: 99, result: {} }) })
})

test('CdpSession rejects pending calls on socket close and refuses new ones', async () => {
  const socket = new FakeSocket()
  const session = new CdpSession('target-1', socket)
  const reply = session.send('Page.navigate')
  socket.emit('close')
  await assert.rejects(reply, /CDP socket closed/)
  await assert.rejects(session.send('Page.navigate'), /CDP session is closed/)
})

test('CdpSession rejects pending calls on socket error', async () => {
  const socket = new FakeSocket()
  const session = new CdpSession('target-1', socket)
  const reply = session.send('Page.navigate')
  socket.emit('error')
  await assert.rejects(reply, /CDP socket error/)
})

test('CdpSession.close rejects pending calls and closes the socket', async () => {
  const socket = new FakeSocket()
  const session = new CdpSession('target-1', socket)
  const reply = session.send('Page.navigate')
  session.close()
  await assert.rejects(reply, /CDP socket closed|CDP session was closed/)
  assert.equal(socket.closed, true)
})
