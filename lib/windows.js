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
 * a previous process. That URL narrows the webviews parented to the window; when
 * several show it, only the one that completes a frame capture is the rendered
 * pane (hidden panes never complete), so `selectPane` probes capture completion
 * in parallel instead of guessing by target order. A restore screen's bar is
 * stale (it names no live pane of this view), so such a window reports no pane.
 */

import { connect, evaluate, sleep } from './cdp.js'
import { matchVisiblePanes } from './scope.js'

/** Key the DSH shell writes the displayed Session id to. */
const CURRENT_SESSION_KEY = 'dsh.sessions.current'

/** Bound for the 1×1 capture that distinguishes the rendered same-URL pane. */
export const CAPTURE_PROBE_TIMEOUT_MS = 2500

const CAPTURE_PROBE_PARAMS = {
  format: 'png',
  clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
}

const PANE_ERROR_MESSAGES = {
  'no-capture': "could not identify the browser pane visible in this session's view: none of the "
    + 'same-URL panes completed a frame capture; bring this session\'s DSH window to the front and retry',
  ambiguous: "could not identify the browser pane visible in this session's view: several same-URL "
    + 'panes completed a frame capture; bring this session\'s DSH window to the front and retry',
}

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
 * Whether `view` completes a tiny screenshot within {@link CAPTURE_PROBE_TIMEOUT_MS}.
 *
 * Capture completion tracks the rendered pane; requestAnimationFrame does not
 * across view switches, and hidden panes never complete the capture. The probe
 * session is always closed, which rejects an abandoned capture (CdpSession.close
 * fails pending calls) so it cannot leak or hang the process. Image data is
 * discarded.
 *
 * @param view - webview target to probe.
 * @param deps - injectable `connect`/`send`/`sleep` (tests); production defaults.
 * @returns true only when the capture completes in time.
 */
export async function probeCaptureCompletion(view, deps = {}) {
  const connectFn = deps.connect ?? connect
  const sendFn = deps.send ?? ((session, method, params) => session.send(method, params))
  const sleepFn = deps.sleep ?? sleep
  let session
  try {
    session = await connectFn(view)
    const capture = (async () => {
      await sendFn(session, 'Page.captureScreenshot', CAPTURE_PROBE_PARAMS)
      return true
    })().catch(() => false)
    return await Promise.race([capture, sleepFn(CAPTURE_PROBE_TIMEOUT_MS).then(() => false)])
  } catch {
    return false
  } finally {
    try {
      session?.close?.()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Pick the pane the window's visible view is showing from its URL candidates.
 *
 * 0 or 1 URL-matching webview needs no probe. With 2+ (identical URLs in other
 * views) the candidates are probed in parallel: exactly one completer is the
 * rendered pane. Zero completers (window not front/active) or several are
 * reported via a machine-readable `paneError` instead of a first-match guess.
 *
 * @param views - every webview target hosted by the window.
 * @param visiblePaneUrl - value of the window's visible address bar.
 * @param deps - injectable `connect`/`send`/`sleep` (tests); production defaults.
 */
export async function selectPane(views, visiblePaneUrl, deps = {}) {
  const candidates = matchVisiblePanes(views, visiblePaneUrl)
  if (candidates.length === 0) return { pane: null, paneError: null, paneErrorMessage: null }
  if (candidates.length === 1) return { pane: candidates[0], paneError: null, paneErrorMessage: null }

  const completed = await Promise.all(
    candidates.map((candidate) => probeCaptureCompletion(candidate, deps)),
  )
  const winners = candidates.filter((_candidate, index) => completed[index])
  if (winners.length === 1) return { pane: winners[0], paneError: null, paneErrorMessage: null }
  const kind = winners.length === 0 ? 'no-capture' : 'ambiguous'
  return { pane: null, paneError: kind, paneErrorMessage: PANE_ERROR_MESSAGES[kind] }
}

/**
 * Group CDP targets into windows with their displayed Session, visible pane URL
 * and the pane that URL identifies.
 *
 * `views` holds every webview the window hosts (other session views' panes stay
 * alive but hidden); `pane` is only ever a URL-matched view that capture
 * completion identified when several matched. There is no first-webview
 * fallback: a hidden view's pane is never chosen.
 *
 * A view showing the RESTORE screen (loaded in a previous process) has a stale
 * address bar and no webview of its own, so its `pane` is null even when a
 * webview URL coincidentally equals the bar value; it is never probed.
 *
 * @param targets - raw CDP target list.
 * @param deps - injectable `connect`/`evaluate` for shell reads and
 *   `connect`/`send`/`sleep` for capture probes (tests); production defaults.
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
    const selection = shell.restoring
      ? { pane: null, paneError: null, paneErrorMessage: null }
      : await selectPane(views, shell.visiblePaneUrl, deps)
    windows.push({
      pageTargetId: page.id,
      pageTitle: page.title ?? '',
      page,
      currentSessionId: shell.currentSessionId,
      visiblePaneUrl: shell.visiblePaneUrl,
      restoring: shell.restoring,
      readError,
      views,
      pane: selection.pane,
      paneError: selection.paneError,
      paneErrorMessage: selection.paneErrorMessage,
    })
  }
  return windows
}
