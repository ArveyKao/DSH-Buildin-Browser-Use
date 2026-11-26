/**
 * Minimal Chrome DevTools Protocol client for the DSH Desktop built-in browser.
 *
 * DSH renders sidebar browser pages in a WebContentsView owned by the Electron
 * main process, so no in-process plugin can reach them; `--remote-debugging-port`
 * publishes them as CDP targets and this module talks to those over WebSocket.
 */

const DEFAULT_TIMEOUT_MS = 20000;

/** A single CDP WebSocket session bound to one target. */
export class CdpSession {
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(targetId, socket) {
    this.targetId = targetId;
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('CDP socket closed'));
      this.#pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      /* already closed */
    }
  }
}

/** Fetch the current CDP target list. */
export async function fetchTargets(endpoint) {
  let response;
  try {
    response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(
      `Cannot reach the CDP endpoint at ${endpoint} (${error.message}). `
        + 'DSH Desktop is running without --remote-debugging-port; launch it through the '
        + '"DSH with CDP" launcher so the built-in browser is available.',
    );
  }
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status} from ${endpoint}`);
  return response.json();
}

/** Open a WebSocket session to one target. */
export async function connect(target, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${target.url}`)), timeoutMs);
    timer.unref?.();
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Failed to open CDP socket for ${target.url}`)); }, { once: true });
  });
  return new CdpSession(target.id, socket);
}

/** Evaluate an expression in a session and return its value. */
export async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`Page evaluation failed: ${detail}`);
  }
  return result.result?.value;
}

/** Dispatch one trusted mouse click at viewport coordinates. */
export async function clickAt(session, x, y) {
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
}

/** Dispatch a trusted key press; `text` makes Enter actually submit. */
export async function pressKey(session, { key, code, virtualKeyCode, text, modifiers = 0 }) {
  const base = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers };
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
