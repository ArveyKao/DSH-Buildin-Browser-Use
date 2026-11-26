/**
 * Session → browser-pane selection.
 *
 * DSH keeps one browser-pane UI per session VIEW, so the pane a Session drives
 * is the pane VISIBLE in that Session's view, not one shared per-window pane.
 * `lib/windows.js` reads each window's visible address bar and matches its URL
 * against that window's webview targets; `matchVisiblePane` is that match.
 *
 * Primary key: each window's shell page stores the displayed Session id in
 * `localStorage['dsh.sessions.current']` (read by `lib/windows.js`). The window
 * showing the caller decides which view's visible pane is the caller's. No
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
 * Normalize a pane URL for comparison.
 * @param value - raw address-bar value or target URL.
 * @returns normalized href, or null when absent/invalid.
 */
function normalizePaneUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  // DSH shows a page either as `…/path/` or `…/path`; a trailing slash on a
  // non-root path must not hide the caller's own webview behind a near miss.
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1)
  }
  return url.href
}

/**
 * Match the visible address-bar URL to one of a window's webview targets.
 *
 * The visible bar belongs to the session view the user is looking at, so its URL
 * identifies the caller's webview even when other views' webviews exist.
 *
 * @param views - all webview targets hosted by the window.
 * @param visiblePaneUrl - value of the window's visible address bar (may be null).
 * @returns the first webview whose URL matches, or null.
 */
export function matchVisiblePane(views, visiblePaneUrl) {
  const wanted = normalizePaneUrl(visiblePaneUrl)
  if (wanted === null || !Array.isArray(views)) return null
  for (const view of views) {
    if (normalizePaneUrl(view?.url) === wanted) return view
  }
  return null
}

/**
 * Choose the pane visible in the session view that displays the calling Session.
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
        reason: "pane visible in the caller's session view",
      }
    }
    return {
      chosen: null,
      callerWindow: ownWindow,
      matchedBy: 'session-id',
      reason: "no pane is visible in the caller's session view yet",
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
            ? 'pane visible in the window titled for this session (session id unavailable)'
            : 'the window titled for this session has no visible pane yet',
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
