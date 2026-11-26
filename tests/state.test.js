import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  loadCookies,
  restoreCookiesOnce,
  saveCookies,
  snapshotCookies,
  workspaceKey,
  workspaceStatePath,
} from '../lib/state.js'

// The state module resolves ~/.dsh/browser-state on every call, so pointing HOME
// at a throwaway directory keeps tests off the real user state.
let home

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-workspace-browser-'))
  process.env.HOME = home
})

after(async () => {
  await rm(home, { recursive: true, force: true })
})

/** CDP session double that records calls and answers with per-method handlers. */
function fakeSession(handlers = {}) {
  const calls = []
  return {
    calls,
    async send(method, params = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      return handler === undefined ? {} : handler(params)
    },
  }
}

const cookie = (name, value) => ({ name, value, domain: 'example.com', path: '/' })

test('workspaceKey is a stable 16-hex digest of workspace identity', () => {
  const key = workspaceKey({ id: 'ws-1' })
  assert.match(key, /^[0-9a-f]{16}$/)
  assert.equal(workspaceKey({ id: 'ws-1' }), key)
  assert.equal(workspaceKey({ id: 'ws-1', path: '/a' }), key)
  assert.equal(workspaceKey({ id: 'ws-1', path: '/b' }), key)
  assert.equal(workspaceKey({ path: '/a' }), workspaceKey({ path: '/a' }))
  assert.notEqual(workspaceKey({ id: 'ws-1' }), workspaceKey({ id: 'ws-2' }))
  assert.notEqual(workspaceKey({ id: 'ws-1' }), workspaceKey({ path: '/a' }))
  assert.equal(workspaceKey(undefined), workspaceKey({}))
  assert.match(workspaceKey(undefined), /^[0-9a-f]{16}$/)
})

test('workspaceStatePath lives under the per-workspace state directory', () => {
  const workspace = { id: 'state-path-ws' }
  assert.equal(
    workspaceStatePath(workspace),
    join(home, '.dsh', 'browser-state', `${workspaceKey(workspace)}.json`),
  )
})

test('snapshot then restore round-trips cookies for one workspace', async () => {
  const workspace = { id: 'roundtrip-ws' }
  const cookies = [cookie('sid', 'abc'), cookie('theme', 'dark')]

  const snapshotSession = fakeSession({ 'Network.getAllCookies': () => ({ cookies }) })
  assert.equal(await snapshotCookies(snapshotSession, workspace), 2)
  assert.equal(snapshotSession.calls[0].method, 'Network.enable')
  assert.deepEqual(await loadCookies(workspace), cookies)

  const stored = JSON.parse(await readFile(workspaceStatePath(workspace), 'utf8'))
  assert.equal(typeof stored.savedAt, 'string')
  assert.deepEqual(stored.cookies, cookies)

  const restoreSession = fakeSession()
  assert.equal(await restoreCookiesOnce(restoreSession, workspace), 'restored')
  const setCookies = restoreSession.calls.find((call) => call.method === 'Network.setCookies')
  assert.ok(setCookies)
  assert.deepEqual(setCookies.params.cookies, cookies)
})

test('restore runs once per process for a workspace', async () => {
  const workspace = { id: 'restore-once-ws' }
  await saveCookies(workspace, [cookie('sid', 'once')])

  const first = fakeSession()
  assert.equal(await restoreCookiesOnce(first, workspace), 'restored')
  assert.equal(first.calls.filter((call) => call.method === 'Network.setCookies').length, 1)

  const second = fakeSession()
  assert.equal(await restoreCookiesOnce(second, workspace), 'already-restored')
  assert.equal(second.calls.length, 0)
})

test('a failed setCookies is retried instead of being marked restored', async () => {
  const workspace = { id: 'retry-ws' }
  await saveCookies(workspace, [cookie('sid', 'retry')])

  const failing = fakeSession({
    'Network.setCookies': () => { throw new Error('CDP connection lost') },
  })
  await assert.rejects(restoreCookiesOnce(failing, workspace), /CDP connection lost/)

  const retry = fakeSession()
  assert.equal(await restoreCookiesOnce(retry, workspace), 'restored')
})

test('cookie files are isolated per workspace', async () => {
  const a = { id: 'isolated-a' }
  const b = { id: 'isolated-b' }
  await saveCookies(a, [cookie('sid', 'a-only')])

  assert.notEqual(workspaceStatePath(a), workspaceStatePath(b))
  assert.deepEqual(await loadCookies(b), [])

  const sessionB = fakeSession()
  assert.equal(await restoreCookiesOnce(sessionB, b), 'empty')
  assert.equal(sessionB.calls.length, 0)
  assert.deepEqual(await loadCookies(a), [cookie('sid', 'a-only')])
})

test('a malformed snapshot never overwrites an existing cookie file', async () => {
  const workspace = { id: 'malformed-ws' }
  await saveCookies(workspace, [cookie('sid', 'keep-me')])

  const session = fakeSession({ 'Network.getAllCookies': () => ({}) })
  await assert.rejects(snapshotCookies(session, workspace), /no cookie list/)
  assert.deepEqual(await loadCookies(workspace), [cookie('sid', 'keep-me')])
})

test('an empty cookie list is persisted as a real empty snapshot', async () => {
  const workspace = { id: 'empty-ws' }
  const session = fakeSession({ 'Network.getAllCookies': () => ({ cookies: [] }) })
  assert.equal(await snapshotCookies(session, workspace), 0)
  assert.deepEqual(await loadCookies(workspace), [])
})

test('a corrupt cookie file loads as empty', async () => {
  const workspace = { id: 'corrupt-ws' }
  const path = workspaceStatePath(workspace)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'not json')
  assert.deepEqual(await loadCookies(workspace), [])
})

test('cookie files are written with private permissions', { skip: process.platform === 'win32' }, async () => {
  const workspace = { id: 'mode-ws' }
  await saveCookies(workspace, [cookie('sid', 'secret')])
  const { mode } = await stat(workspaceStatePath(workspace))
  assert.equal(mode & 0o777, 0o600)
})
