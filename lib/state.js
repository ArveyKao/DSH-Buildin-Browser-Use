/**
 * Per-workspace cookie persistence.
 *
 * The built-in browser uses an in-memory partition per workspace
 * (`dsh-sidebar-browser-<uuid>`), so logins are lost on every DSH restart. Cookies
 * are snapshotted over CDP and stored per workspace under
 * `~/.dsh/browser-state/<hash>.json`, then re-injected on first use in a new app
 * process. Files are keyed by workspace identity and never merged across
 * workspaces.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Workspaces already restored in this process, so restore happens once. */
const restored = new Set()

/** Panes this process has bound to a workspace (`paneTargetId` -> workspace hash). */
const paneBindings = new Map()

/**
 * Stable key for a workspace identity.
 * @param workspace - workspace record (`id` or `path`).
 */
export function workspaceKey(workspace) {
  const identity = workspace?.id ?? workspace?.path ?? 'unknown-workspace'
  return createHash('sha256').update(String(identity)).digest('hex').slice(0, 16)
}

/**
 * Record which workspace a pane belongs to.
 * @param paneId - CDP webview target id.
 * @param workspace - workspace record.
 */
export function bindPane(paneId, workspace) {
  paneBindings.set(paneId, workspaceKey(workspace))
}

/**
 * Which workspace a pane was bound to, if any.
 * @param paneId - CDP webview target id.
 */
export function paneWorkspace(paneId) {
  return paneBindings.get(paneId)
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
 * @param cookies - cookie list from `Storage.getCookies`.
 */
export async function saveCookies(workspace, cookies) {
  const path = workspaceStatePath(workspace)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 1), { mode: 0o600 })
}

/**
 * Restore a workspace's cookies into a browser session, once per process.
 * @param session - CDP session of the workspace pane.
 * @param workspace - workspace record.
 * @returns 'restored' | 'empty' | 'already-restored'
 */
export async function restoreCookiesOnce(session, workspace) {
  const path = workspaceStatePath(workspace)
  if (restored.has(path)) return 'already-restored'
  const cookies = await loadCookies(workspace)
  restored.add(path)
  if (cookies.length === 0) return 'empty'
  await session.send('Network.enable').catch(() => {})
  await session.send('Network.setCookies', { cookies })
  return 'restored'
}

/**
 * Snapshot the pane's cookies and persist them for its workspace.
 * @param session - CDP session of the workspace pane.
 * @param workspace - workspace record.
 * @returns number of cookies persisted.
 */
export async function snapshotCookies(session, workspace) {
  // Storage.getCookies returns nothing in this Electron build (verified: 0 while
  // Network.getAllCookies returned 22), so read through the Network domain.
  await session.send('Network.enable').catch(() => {})
  const result = await session.send('Network.getAllCookies')
  const cookies = Array.isArray(result?.cookies) ? result.cookies : []
  await saveCookies(workspace, cookies)
  return cookies.length
}
