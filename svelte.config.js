import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: false
    }),
    alias: {
      $shared: 'src/lib/shared',
      '$shared/*': 'src/lib/shared/*'
    },
    // Let SvelteKit emit the CSP header. In `hash` mode it adds the SHA-256
    // of every inline <script> it generates (the hydration bootstrap, dev-
    // server HMR glue, etc.) to `script-src`, so we can keep `script-src
    // 'self'` without killing hydration. A flat `script-src 'self'` set by
    // hand in hooks.server.ts blocks the bootstrap, and every onclick in
    // the app dies silently as a result.
    csp: {
      // Source tokens here are bare words (`'self'`, `'unsafe-inline'`,
      // `'none'`, `data:`) — SvelteKit wraps the keyword ones in quotes
      // when it emits the header.
      mode: 'hash',
      directives: {
        'default-src': ['self'],
        'img-src': ['self', 'data:'],
        'style-src': ['self', 'unsafe-inline'],
        'script-src': ['self'],
        // SvelteKit's Source type doesn't list bare-scheme tokens like
        // `ws:` / `wss:`, but CSP itself accepts them and the WebSocket
        // hub needs them. Cast to any to get past the type wall.
        'connect-src': /** @type {any} */ (['self', 'ws:', 'wss:']),
        'frame-ancestors': ['none'],
        'base-uri': ['self'],
        'form-action': ['self']
      }
    }
  }
};

export default config;
