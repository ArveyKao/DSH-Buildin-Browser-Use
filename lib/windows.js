/**
 * Read every DSH window, the Session it currently displays, and the pane its
 * visible session view is showing.
 *
 * A window's CDP `page` target exposes the shown Session in its own
 * `localStorage['dsh.sessions.current']` as `{"sessionId":"session-…"}`. That is
 * an exact key, unlike matching window titles against Session titles (which
 * fails whenever a Session has no title yet).
 *
 * DSH keeps one browser-pane UI per session VIEW. Every view's pane UI is
 * mounted in the same window shell, but only the visible view's address bar has
 * a non-zero width (hidden views report width 0). One shell evaluate per window
 * therefore reads both the stored Session id and the VISIBLE address bar's
 * value, plus whether the view is showing the restore screen of a pane loaded in
 * a previous process. That URL identifies which webview target the user is
 * looking at; `matchVisiblePane` picks it from all webviews parented to the
 * window. A restore screen's bar is stale (it names no live pane of this view),
 * so such a window reports no pane.
 */

import { connect, evaluate } from './cdp.js'
import { matchVisiblePane } from './scope.js'

/** Key the DSH shell writes the displayed Session id to. */
const CURRENT_SESSION_KEY = 'dsh.sessions.current'

/**
 * One shell evaluate per window: stored Session id, the visible address bar's
 * value, and whether a visible "Restore page" affordance is mounted. Hidden
 * pane UIs have a 0-width rect and are skipped. A restore screen belongs to a
 * view loaded in a previous process: its bar is stale and no webview of its own
 * exists yet.
 */
export const WINDOW_SHELL_SCRIPT = `(() => {
  const bar = Array.from(document.querySelectorAll('input'))
    .filter((el) => /Enter an HTTP\\(S\\) address/i.test(el.placeholder || ''))
    .find((el) => el.getBoundingClientRect().width > 0)
  const restoring = Array.from(document.querySelectorAll('button,a,[role="button"]'))
    .some((el) => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
        && (el.textContent || '').trim() === 'Restore page'
    })
  return JSON.stringify({
    current: localStorage.getItem(${JSON.stringify(CURRENT_SESSION_KEY)}),
    address: bar ? bar.value : null,
    restoring,
  })
})()`

/**
 * Parse the raw `localStorage` value into a Session id.
 * @param raw - string returned by `localStorage.getItem`, or anything else.
 * @returns the Session id, or null when absent/unparseable/empty.
 */
export function parseCurrentSession(raw) {
  if (typeof raw !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed?.sessionId !== 'string') return null
  const sessionId = parsed.sessionId.trim()
  return sessionId.length === 0 ? null : sessionId
}

/**
 * Reduce a raw address-bar value to a usable URL.
 * @param raw - `input.value` (or anything else).
 * @returns the trimmed URL, or null for a missing/empty value.
 */
export function parseVisiblePaneUrl(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Parse the shell evaluate payload into the values a window record needs.
 * @param raw - JSON string (or already-parsed object) from `WINDOW_SHELL_SCRIPT`.
 */
export function parseWindowShell(raw) {
  let parsed = null
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  } else if (raw !== null && typeof raw === 'object') {
    parsed = raw
  }
  return {
    currentSessionId: parseCurrentSession(parsed?.current),
    visiblePaneUrl: parseVisiblePaneUrl(parsed?.address),
    restoring: parsed?.restoring === true,
  }
}

/**
 * Read the displayed Session id and visible address-bar URL from one window.
 * @param page - CDP page target of the window.
 * @param deps - injectable `connect`/`evaluate` (tests); production defaults.
 */
export async function readWindowShell(page, deps = {}) {
  const connectFn = deps.connect ?? connect
  const evaluateFn = deps.evaluate ?? evaluate
  const session = await connectFn(page)
  try {
    return parseWindowShell(await evaluateFn(session, WINDOW_SHELL_SCRIPT))
  } finally {
    session.close()
  }
}

/**
 * Group CDP targets into windows with their displayed Session, visible pane URL
 * and the pane that URL identifies.
 *
 * `views` holds every webview the window hosts (other session views' panes stay
 * alive but hidden); `pane` is only ever the URL-matched view. There is no
 * first-webview fallback: a hidden view's pane is never chosen.
 *
 * A view showing the RESTORE screen (loaded in a previous process) has a stale
 * address bar and no webview of its own, so its `pane` is null even when a
 * webview URL coincidentally equals the bar value.
 *
 * @param targets - raw CDP target list.
 * @param deps - injectable `connect`/`evaluate` (tests); production defaults.
 */
export async function readWindows(targets, deps = {}) {
  const pages = targets.filter((target) => target.type === 'page')
  const windows = []
  for (const page of pages) {
    let shell = { currentSessionId: null, visiblePaneUrl: null, restoring: false }
    let readError = null
    try {
      shell = await readWindowShell(page, deps)
    } catch (error) {
      readError = error.message
    }
    const views = targets.filter(
      (target) => target.type === 'webview' && target.parentId === page.id,
    )
    windows.push({
      pageTargetId: page.id,
      pageTitle: page.title ?? '',
      page,
      currentSessionId: shell.currentSessionId,
      visiblePaneUrl: shell.visiblePaneUrl,
      restoring: shell.restoring,
      readError,
      views,
      pane: shell.restoring ? null : matchVisiblePane(views, shell.visiblePaneUrl),
    })
  }
  return windows
}
