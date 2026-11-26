/**
 * Per-workspace cookie persistence.
 *
 * The built-in browser's cookie jar is in memory, so logins are lost on every DSH
 * restart. Cookies are snapshotted over CDP and stored per CALLING WORKSPACE under
 * `~/.dsh/browser-state/<hash>.json`, then re-injected on first use in a new app
 * process. The jar itself belongs to the pane, so whoever drives it sees the same
 * cookies; files stay keyed by workspace identity and are never merged.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Workspaces already restored in this process, so restore happens once. */
const restored = new Set()

/**
 * Stable key for a workspace identity.
 * @param workspace - workspace record (`id` or `path`).
 */
export function workspaceKey(workspace) {
  const identity = workspace?.id ?? workspace?.path ?? 'unknown-workspace'
  return createHash('sha256').update(String(identity)).digest('hex').slice(0, 16)
}

/**
 * Stable file path for a workspace's cookies.
 * @param workspace - workspace record (`id` or `path`).
 */
export function workspaceStatePath(workspace) {
  return join(homedir(), '.dsh', 'browser-state', `${workspaceKey(workspace)}.json`)
}

/**
 * Read persisted cookies for a workspace.
 * @param workspace - workspace record.
 */
export async function loadCookies(workspace) {
  try {
    const raw = await readFile(workspaceStatePath(workspace), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.cookies) ? parsed.cookies : []
  } catch {
    return []
  }
}

/**
 * Write a workspace's cookies to disk.
 * @param workspace - workspace record.
 * @param cookies - cookie list from `Network.getAllCookies`.
 */
export async function saveCookies(workspace, cookies) {
  const path = workspaceStatePath(workspace)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 1), { mode: 0o600 })
}

/**
 * Restore a workspace's cookies into a browser session, once per process.
 * @param session - CDP session of the caller-window pane.
 * @param workspace - calling workspace record.
 * @returns 'restored' | 'empty' | 'already-restored'
 */
export async function restoreCookiesOnce(session, workspace) {
  const path = workspaceStatePath(workspace)
  if (restored.has(path)) return 'already-restored'
  const cookies = await loadCookies(workspace)
  if (cookies.length === 0) {
    restored.add(path)
    return 'empty'
  }
  await session.send('Network.enable').catch(() => {})
  // Marked only after the CDP call succeeds, so a transient failure is retried on
  // the next tool call instead of leaving the process logged out.
  await session.send('Network.setCookies', { cookies })
  restored.add(path)
  return 'restored'
}

/**
 * Snapshot the pane's cookies and persist them for its workspace.
 * @param session - CDP session of the caller-window pane.
 * @param workspace - calling workspace record.
 * @returns number of cookies persisted.
 */
export async function snapshotCookies(session, workspace) {
  // Storage.getCookies returns nothing in this Electron build (verified: 0 while
  // Network.getAllCookies returned 22), so read through the Network domain.
  await session.send('Network.enable').catch(() => {})
  const result = await session.send('Network.getAllCookies')
  // A missing list (not an empty one) is an error; never overwrite a good file
  // with a malformed response.
  if (!Array.isArray(result?.cookies)) {
    throw new Error('Network.getAllCookies returned no cookie list; workspace cookies were not overwritten')
  }
  await saveCookies(workspace, result.cookies)
  return result.cookies.length
}
