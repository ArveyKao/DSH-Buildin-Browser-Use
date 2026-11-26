/**
 * Session → browser-pane selection.
 *
 * The pane belongs to the WINDOW that hosts it, not to a workspace: a Session
 * drives the pane of the window it is displayed in, whichever workspace opened
 * the pane. DSH lets the user switch any Session into any window, so switching
 * sessions hands the pane over instead of orphaning it.
 *
 * Primary key: each window's shell page stores the displayed Session id in
 * `localStorage['dsh.sessions.current']` (read by `lib/windows.js`). No
 * workspace-membership filtering happens here.
 *
 * Fallback key: window titles read `<session title> — DeepSeek Harness`. Used only
 * when no window yields a session id (older build or an evaluate failure).
 */

/** Separator between a Session title and the product suffix in a window title. */
const WINDOW_TITLE_SUFFIX = ' — DeepSeek Harness'

/**
 * Read a Session's current title from its event log.
 * @param session - live Session (exposes `events`).
 */
export function sessionTitle(session) {
  const events = session?.events
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title
  }
  return undefined
}

/**
 * Extract the Session title from a window title.
 * @param pageTitle - window title as published by CDP.
 */
export function windowSessionTitle(pageTitle) {
  if (typeof pageTitle !== 'string') return undefined
  const at = pageTitle.lastIndexOf(WINDOW_TITLE_SUFFIX)
  return at === -1 ? undefined : pageTitle.slice(0, at)
}

/**
 * Describe every CDP target with the window/pane relationship that matters.
 * @param targets - raw CDP target list.
 */
export function describeTargets(targets) {
  const views = targets.filter((target) => target.type === 'webview')
  return targets.map((target) => ({
    id: target.id,
    type: target.type,
    title: target.title ?? '',
    url: target.url ?? '',
    parentId: target.parentId ?? null,
    hostsPaneOf: target.type === 'page'
      ? views.find((view) => view.parentId === target.id)?.id ?? null
      : null,
  }))
}

/**
 * Choose the pane of the window displaying the calling Session.
 *
 * The caller's own window is authoritative. When the caller is not displayed in
 * any window, the title fallback may still identify its window; otherwise the
 * caller has no pane to drive.
 *
 * @param windows - records from `readWindows`.
 * @param options - caller session id, optional caller title, optional id->title map.
 */
export function chooseCallerPane(windows, options) {
  const { callerSessionId, callerTitle, titles = {} } = options

  const ownWindow = windows.find(
    (win) => typeof callerSessionId === 'string' && win.currentSessionId === callerSessionId,
  )
  if (ownWindow !== undefined) {
    if (ownWindow.pane) {
      return {
        chosen: ownWindow.pane,
        callerWindow: ownWindow,
        matchedBy: 'session-id',
        reason: "pane in the caller's own window",
      }
    }
    return {
      chosen: null,
      callerWindow: ownWindow,
      matchedBy: 'session-id',
      reason: 'the window showing this session has no browser pane yet',
    }
  }

  // Fallback: titles, only when the session-id bridge produced nothing at all.
  const bridged = windows.some((win) => typeof win.currentSessionId === 'string')
  if (!bridged) {
    const wanted = callerTitle ?? titles[callerSessionId]
    if (typeof wanted === 'string' && wanted.length > 0) {
      const titled = windows.find((win) => windowSessionTitle(win.pageTitle) === wanted)
      if (titled !== undefined) {
        return {
          chosen: titled.pane ?? null,
          callerWindow: titled,
          matchedBy: 'title',
          reason: titled.pane
            ? 'pane in the window titled for this session (session id unavailable)'
            : 'the window titled for this session has no browser pane yet',
        }
      }
    }
  }

  return {
    chosen: null,
    callerWindow: null,
    matchedBy: bridged ? 'session-id' : 'title',
    reason: 'this session is not displayed in any open window; switch to it in a DSH window first',
  }
}
