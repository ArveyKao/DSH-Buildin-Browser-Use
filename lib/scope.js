/**
 * Workspace → browser-pane selection.
 *
 * Primary key: each window's shell page stores the displayed Session id in
 * `localStorage['dsh.sessions.current']` (read by `lib/windows.js`). A window
 * belongs to a workspace when that id is one of the workspace's sessions.
 *
 * Fallback key: window titles read `<session title> — DeepSeek Harness`. Used only
 * when no window yields a session id (older build or an evaluate failure), and
 * only when a title can be matched — never across workspaces.
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
 * Choose the pane belonging to the calling Session's workspace.
 *
 * Preference, all restricted to the caller's workspace:
 *  1. the caller's own window pane;
 *  2. any other window pane of the same workspace (the page another session opened);
 *  3. the window that should host a new pane, so `browser_open` can create one there;
 *  4. null.
 *
 * @param windows - records from `readWindows`.
 * @param options - workspace session ids, caller session id, optional titles for fallback.
 */
export function chooseWorkspacePane(windows, options) {
  const { sessionIds = [], callerSessionId, titles = {} } = options
  const members = new Set(sessionIds)

  const idMatched = windows.filter(
    (win) => typeof win.currentSessionId === 'string' && members.has(win.currentSessionId),
  )

  const ownWindow = windows.find(
    (win) => typeof callerSessionId === 'string' && win.currentSessionId === callerSessionId,
  ) ?? null
  // When the caller's own Session is not displayed in any window, any window of the
  // same workspace may host the pane; opening it there keeps one pane per workspace.
  const hostWindow = ownWindow ?? idMatched[0] ?? null

  const ownMatch = idMatched.find((win) => win.currentSessionId === callerSessionId)
  if (ownMatch?.pane) {
    return { chosen: ownMatch.pane, callerWindow: ownWindow ?? ownMatch, matchedBy: 'session-id', reason: 'pane in the caller\'s own window' }
  }
  const shared = idMatched.find((win) => win.pane)
  if (shared) {
    return { chosen: shared.pane, callerWindow: hostWindow, matchedBy: 'session-id', reason: 'pane in another window of the same workspace (session id match)' }
  }

  // Fallback: titles, only when the session-id bridge produced nothing at all.
  const bridged = windows.some((win) => typeof win.currentSessionId === 'string')
  if (!bridged) {
    const wanted = new Set(sessionIds.map((id) => titles[id]).filter(Boolean))
    const titled = windows.find((win) => win.pane && wanted.has(windowSessionTitle(win.pageTitle)))
    if (titled) {
      return { chosen: titled.pane, callerWindow: ownWindow ?? null, matchedBy: 'title', reason: 'pane matched by window title (session id unavailable)' }
    }
  }

  return {
    chosen: null,
    callerWindow: hostWindow,
    matchedBy: bridged ? 'session-id' : 'title',
    reason: idMatched.length === 0
      ? 'no open window shows a session of this workspace'
      : 'a window of this workspace is open but has no browser pane',
  }
}
