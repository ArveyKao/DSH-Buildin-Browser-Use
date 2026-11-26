/**
 * Built-in browser operations over CDP.
 *
 * The pane is a `webview` target; the window that hosts it is a `page` target.
 * All page work happens on the pane's own CDP session. Opening a pane drives the
 * window's shell UI with trusted input events, because synthetic DOM events are
 * ignored by the app (`isTrusted: false`).
 */

import { spawn } from 'node:child_process'
import { clickAt, connect, evaluate, pressKey, sleep } from './cdp.js'

/**
 * Open a URL in the user's own (system default) browser.
 *
 * The built-in pane shares the app's network context, which may lack a VPN or
 * corporate proxy; hosts reachable only through those must be handed to the
 * user's browser instead. Nothing is automated there — no CDP attach, no driving.
 *
 * Uses the platform opener (`open` on macOS); the workspace-browser target is a
 * macOS DSH Desktop build.
 *
 * @param url - http(s) URL to open.
 */
export function openInSystemBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = spawn('open', [url], { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Address-bar placeholder of the DSH browser pane. */
export const ADDRESS_BAR = `(() => {
  const input = [...document.querySelectorAll('input')]
    .find((el) => /Enter an HTTP\\(S\\) address/i.test(el.placeholder || ''))
  if (!input || input.getBoundingClientRect().width === 0) return null
  return 'address-bar'
})()`

/** Snapshot: URL, title, visible text, links and form fields. */
export const SNAPSHOT_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : ''
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 40)
    .map((a) => '- ' + (a.innerText || '').trim().slice(0, 60) + ' -> ' + a.href)
  const fields = Array.from(document.querySelectorAll('input,textarea,select,button')).slice(0, 60)
    .map((el) => '-' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
      + (el.name ? '[name=' + el.name + ']' : '') + ' "'
      + (el.innerText || el.value || el.placeholder || '').trim().slice(0, 40) + '"')
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: text.slice(0, 6000),
    links,
    fields,
  })
})()`

/**
 * Click the first element matching a selector.
 * @param selector - CSS selector.
 */
export const clickScript = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(String(selector))})
  if (!el) return 'not-found'
  if (typeof el.click !== 'function') return 'not-clickable'
  el.scrollIntoView({ block: 'center' })
  el.click()
  return 'clicked'
})()`

/**
 * Set an input value and fire input/change events.
 * @param selector - CSS selector.
 * @param text - value to set.
 */
export const typeScript = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(String(selector))})
  if (!el) return 'not-found'
  const value = ${JSON.stringify(String(text))}
  el.focus()
  if (el.isContentEditable) {
    el.textContent = value
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLInputElement ? HTMLInputElement.prototype
      : null
    const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (!setter) return 'unsupported'
    setter.call(el, value)
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'typed'
})()`

/**
 * Trusted-click the smallest on-screen element whose label matches a pattern.
 * @param session - CDP session of the window's shell page.
 * @param pattern - regular expression source tested against label/text.
 */
async function clickLabel(session, pattern) {
  const position = await evaluate(
    session,
    `(() => {
       const re = new RegExp(${JSON.stringify(pattern)}, 'i')
       const hits = [...document.querySelectorAll('button,[role="button"],[aria-label],div')]
         .map((el) => ({ el, r: el.getBoundingClientRect() }))
         .filter(({ el, r }) =>
           r.width > 0 && r.height > 0
           && r.top >= 0 && r.left >= 0
           && r.bottom <= window.innerHeight && r.right <= window.innerWidth
           && re.test((el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()))
         .sort((a, b) => {
           const la = (a.el.getAttribute('aria-label') || a.el.getAttribute('title') || a.el.textContent || '').trim().length
           const lb = (b.el.getAttribute('aria-label') || b.el.getAttribute('title') || b.el.textContent || '').trim().length
           return la - lb || a.r.width * a.r.height - b.r.width * b.r.height
         })
       if (hits.length === 0) return null
       const r = hits[0].r
       return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
     })()`,
  )
  if (!position) return false
  const { x, y } = JSON.parse(position)
  await clickAt(session, x, y)
  return true
}

/**
 * Open the browser pane in a specific window and optionally load a URL.
 * @param windowPage - CDP page target of the window that should host the pane.
 * @param url - optional URL to load.
 * @param timeoutMs - how long to wait for the pane's address bar to appear.
 */
export async function openPaneInWindow(windowPage, url, timeoutMs = 8000) {
  const session = await connect(windowPage)
  try {
    let bar = await evaluate(session, ADDRESS_BAR)
    if (bar !== 'address-bar') {
      // Reliable path: reveal the right sidebar, then choose its Browser entry.
      await clickLabel(session, '^Open right sidebar$')
      await sleep(400)
      await clickLabel(session, 'Browse web pages')
      const deadline = Date.now() + timeoutMs
      while (bar !== 'address-bar' && Date.now() < deadline) {
        await sleep(300)
        bar = await evaluate(session, ADDRESS_BAR)
      }
    }
    if (bar !== 'address-bar') throw new Error('the window did not reveal a browser pane address bar')

    if (url) {
      const focused = await evaluate(
        session,
        `(() => {
           const input = [...document.querySelectorAll('input')]
             .find((el) => /Enter an HTTP\\(S\\) address/i.test(el.placeholder || ''))
           if (!input) return null
           input.focus(); input.select(); return 'focused'
         })()`,
      )
      if (focused !== 'focused') throw new Error('the browser pane exposes no address bar')
      await session.send('Input.insertText', { text: url })
      await pressKey(session, { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' })
    }
  } finally {
    session.close()
  }

  return { windowTargetId: windowPage.id, url: url ?? null }
}
