/**
 * jsdom env bootstrap for the `client` vitest project.
 *
 * jsdom ships a slimmer browser surface than real Chromium — a few APIs
 * that our client code (and the shadcn-svelte components we mount from
 * it) touches on import/mount are missing. Polyfill them here, once,
 * for every client test.
 */
import '@testing-library/jest-dom/vitest';

// shadcn-svelte components read prefers-color-scheme on mount.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  });
}

// jsdom 26 lacks HTMLDialogElement.showModal/close. The Modal component (and
// anything else using native <dialog>) relies on both. Polyfill them to the
// minimum shape tests need — toggle `.open`, fire a `close` event.
if (
  typeof window !== 'undefined' &&
  // Only polyfill once — repeated client-test bootstraps during dev loops
  // would otherwise stack the same patch multiple times.
  typeof HTMLDialogElement !== 'undefined' &&
  typeof HTMLDialogElement.prototype.showModal !== 'function'
) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// MawWsClient constructs a WebSocket at import time when connect() fires.
// Individual tests replace this with a richer stub; this default keeps
// accidental instantiation from throwing ReferenceError in jsdom.
if (typeof globalThis.WebSocket === 'undefined') {
  class NoopWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly readyState = NoopWebSocket.CONNECTING;
    close() {}
    send() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return false;
    }
  }
  (globalThis as { WebSocket: unknown }).WebSocket = NoopWebSocket;
}

// jsdom has no Web Animations API. Svelte 5's built-in transitions
// (`svelte/transition` — used e.g. by the Tasks page's expandable rows)
// call `element.animate()` on intro/outro and would throw
// "element.animate is not a function". Stub it to an immediately-finished
// Animation: the transition is decorative, so completing it synchronously
// keeps the {#if} mount/unmount semantics intact for assertions.
if (
  typeof Element !== 'undefined' &&
  typeof Element.prototype.animate !== 'function'
) {
  Element.prototype.animate = function animate() {
    const anim = {
      cancel() {},
      play() {},
      pause() {},
      finish() {},
      reverse() {},
      addEventListener() {},
      removeEventListener() {},
      onfinish: null as null | (() => void),
      finished: Promise.resolve(),
      currentTime: 0,
      playState: 'finished'
    };
    // Drive completion so Svelte's outro removes the node promptly.
    queueMicrotask(() => anim.onfinish?.());
    return anim as unknown as Animation;
  };
}
