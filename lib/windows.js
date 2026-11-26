/**
 * Read every DSH window and the Session it currently displays.
 *
 * A window's CDP `page` target exposes the shown Session in its own
 * `localStorage['dsh.sessions.current']` as `{"sessionId":"session-…"}`. That is
 * an exact key, unlike matching window titles against Session titles (which
 * fails whenever a Session has no title yet). Each window stores its own value,
 * so the read must happen per page target.
 */

import { connect, evaluate } from './cdp.js'

/** Key the DSH shell writes the displayed Session id to. */
const CURRENT_SESSION_KEY = 'dsh.sessions.current'

/**
 * Read the displayed Session id from one window page target.
 * @param page - CDP page target of the window.
 * @returns the Session id, or null when absent/unparseable.
 */
export async function readWindowSessionId(page) {
  const session = await connect(page)
  try {
    const raw = await evaluate(session, `localStorage.getItem(${JSON.stringify(CURRENT_SESSION_KEY)})`)
    if (typeof raw !== 'string') return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.sessionId === 'string' ? parsed.sessionId : null
  } finally {
    session.close()
  }
}

/**
 * Group CDP targets into windows with their displayed Session and hosted pane.
 * @param targets - raw CDP target list.
 */
export async function readWindows(targets) {
  const pages = targets.filter((target) => target.type === 'page')
  const views = targets.filter((target) => target.type === 'webview')

  const windows = []
  for (const page of pages) {
    let currentSessionId = null
    let readError = null
    try {
      currentSessionId = await readWindowSessionId(page)
    } catch (error) {
      readError = error.message
    }
    windows.push({
      pageTargetId: page.id,
      pageTitle: page.title ?? '',
      page,
      currentSessionId,
      readError,
      pane: views.find((view) => view.parentId === page.id) ?? null,
    })
  }
  return windows
}
