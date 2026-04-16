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
