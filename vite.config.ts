/// <reference types="vitest" />
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { generateVersionInfo } from './scripts/gen-version.mjs';

const {
  version: appVersion,
  buildNumber: appBuildNumber,
  buildDate: appBuildDate
} = generateVersionInfo();

/**
 * Dev WebSocket plugin: attaches a `ws` server to Vite's HTTP server so the
 * same `/ws` path works in both dev and prod (where server.js does the same).
 *
 * IMPORTANT: we load bootstrap + hub via Vite's `server.ssrLoadModule()`
 * rather than `import()`, because SvelteKit's `$shared` / `$lib` aliases are
 * registered in Vite's resolver — not in Node's native module loader. Using
 * ssrLoadModule keeps dev in the same resolution pipeline as hooks.server.ts.
 */
function devWebSocketPlugin(): PluginOption {
  return {
    name: 'maw-dev-websocket',
    apply: 'serve',
    configureServer(server) {
      if (!server.httpServer) return;

      const wss = new WebSocketServer({ noServer: true });

      server.httpServer.on(
        'upgrade',
        async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (url.pathname !== '/ws') return; // let HMR + other handlers take it

            const bootstrapMod = (await server.ssrLoadModule(
              '/src/lib/server/bootstrap.ts'
            )) as typeof import('./src/lib/server/bootstrap.js');
            const hubMod = (await server.ssrLoadModule(
              '/src/lib/server/ws/hub.ts'
            )) as typeof import('./src/lib/server/ws/hub.js');

            await bootstrapMod.bootstrap();
            wss.handleUpgrade(req, socket, head, (ws) => {
              hubMod.getWsHub().attach(ws, req);
            });
          } catch (err) {
            server.config.logger.error(`[maw-dev-websocket] upgrade error: ${err}`);
            socket.destroy();
          }
        }
      );
    }
  };
}

/**
 * Dev plugin: forward /preview/<agentId>/* HTTP requests AND WebSocket
 * upgrades to the agent's localhost target — same routing as server.js
 * does in prod, just hooked into Vite's middleware/upgrade chain so the
 * iframe works during `pnpm dev` too.
 */
function devPreviewProxyPlugin(): PluginOption {
  return {
    name: 'maw-dev-preview-proxy',
    apply: 'serve',
    configureServer(server) {
      // HTTP forwarding: register a middleware that lets the proxy module
      // decide whether to claim the request. It catches both `/preview/*`
      // direct paths AND any path whose Referer is a preview iframe (so
      // SPAs emitting absolute paths like `/@vite/client` route correctly).
      server.middlewares.use(async (req, res, next) => {
        try {
          const proxyMod = (await server.ssrLoadModule(
            '/src/lib/server/preview/proxy.ts'
          )) as typeof import('./src/lib/server/preview/proxy.js');
          const bootstrapMod = (await server.ssrLoadModule(
            '/src/lib/server/bootstrap.ts'
          )) as typeof import('./src/lib/server/bootstrap.js');
          await bootstrapMod.bootstrap();
          if (proxyMod.handlePreviewRequest(req, res)) return;
          next();
        } catch (err) {
          server.config.logger.error(`[maw-dev-preview-proxy] http error: ${err}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('preview proxy: internal error');
          }
        }
      });

      // WS forwarding: hook the same `upgrade` event (parallel listener
      // alongside the /ws hub handler). Same Referer-fallback trick as the
      // HTTP path so Vite HMR sockets connect through the proxy.
      if (!server.httpServer) return;
      server.httpServer.on(
        'upgrade',
        async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          // Skip MAW's own /ws — handled by `devWebSocketPlugin`.
          if (req.url === '/ws' || req.url?.startsWith('/ws?')) return;
          try {
            const proxyMod = (await server.ssrLoadModule(
              '/src/lib/server/preview/proxy.ts'
            )) as typeof import('./src/lib/server/preview/proxy.js');
            const bootstrapMod = (await server.ssrLoadModule(
              '/src/lib/server/bootstrap.ts'
            )) as typeof import('./src/lib/server/bootstrap.js');
            await bootstrapMod.bootstrap();
            proxyMod.handlePreviewUpgrade(req, socket, head);
          } catch (err) {
            server.config.logger.error(`[maw-dev-preview-proxy] upgrade error: ${err}`);
            socket.destroy();
          }
        }
      );
    }
  };
}

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), devWebSocketPlugin(), devPreviewProxyPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD_NUMBER__: JSON.stringify(appBuildNumber),
    __APP_BUILD_DATE__: JSON.stringify(appBuildDate)
  },
  // Better-auth ships pre-compiled chunks that pin to zod@4 (`.meta(…)`),
  // while the rest of the app uses the top-level zod@3 for adapter schemas.
  // Bundling better-auth through Vite's SSR analyse step inlines our zod@3,
  // so the precompiled chunks crash on the first .meta() call. Keep it
  // external so Node's module resolver hands it its own zod@4 at runtime.
  ssr: {
    external: ['better-auth', 'better-auth/svelte-kit', 'better-auth/api']
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  },
  // Use terser instead of esbuild for the client bundle minifier.
  // The Vite client build target SvelteKit configures is
  // ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14']. Logical
  // assignment (`||=`) is ES2021, so esbuild has to transpile it for that
  // target. The transpile-then-minify pipeline mishandles xterm 6.0's
  // function-scoped enum init pattern (`let r; ...(r ||= {})` where `r` is
  // never read after the assignment): it drops `let r;` while keeping the
  // renamed `i = {}` assignment, producing `(void 0||(i={}))` against an
  // undeclared `i`. Strict-mode ESM rejects it on every incoming DECRQM byte,
  // blanking the Show-Log modal with `ReferenceError: assignment to
  // undeclared variable i` for TUI agents (claude-code, codex, gemini).
  // Terser doesn't have this transpile+DCE interaction bug.
  // See docs/plans/v0.2-fix-xterm-minify-undeclared-i.md.
  build: {
    minify: 'terser'
  },
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,svelte}'],
      exclude: [
        'src/lib/components/ui/**',
        'src/**/*.d.ts',
        'src/app.html',
        'src/service-worker.ts'
      ],
      thresholds: {
        // Ratcheted by each phase of v0.2-vitest-unit-tests.md. Numbers
        // sit just below current actuals so the gate bites on regressions
        // without false alarms on CI jitter. Phase 9 added a first Svelte
        // 5 component test (Modal) plus a jsdom `<dialog>` polyfill and
        // the `resolve.conditions: ['browser']` client-project tweak
        // that makes @testing-library/svelte mount() resolve to Svelte's
        // client build. Branches lowered 85→84 by v0.2-better-auth-migration:
        // the rateLimit.ts and session.ts deletes (high-branch utilities)
        // shifted the global percentage even though every remaining branch
        // is still covered.
        lines: 26,
        branches: 84,
        functions: 70,
        statements: 26
      }
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: [
            'src/lib/server/**/*.{test,spec}.ts',
            'src/lib/shared/**/*.{test,spec}.ts',
            'scripts/**/*.{test,spec}.ts',
            // Route-handler tests collocated with `+server.ts` are
            // semantically server-side (the handler runs in Node), and
            // jsdom's fetch implementation rejects multipart `FormData`
            // bodies — so route tests that exercise `request.formData()`
            // can't run in the client project.
            'src/routes/**/server.{test,spec}.ts'
          ]
        }
      },
      {
        extends: true,
        resolve: {
          // Svelte 5 ships separate `svelte/index.js` (client) and
          // `svelte/index-server.js` (server) entries, dispatched via
          // export conditions. Vitest defaults to Node conditions, which
          // picks the SSR entry — causing @testing-library/svelte mount()
          // to explode with "lifecycle_function_unavailable". Force the
          // browser build for client component tests.
          conditions: ['browser']
        },
        test: {
          name: 'client',
          environment: 'jsdom',
          include: [
            'src/lib/client/**/*.{test,spec}.ts',
            'src/lib/components/**/*.{test,spec}.ts',
            'src/routes/**/*.{test,spec}.ts'
          ],
          // Server-side route tests live under `src/routes/**` next to
          // their `+server.ts` (e.g. `plan/server.test.ts`). The
          // server-project include claims them; exclude them here so they
          // don't double-run.
          exclude: ['src/routes/**/server.{test,spec}.ts'],
          setupFiles: ['tests/unit/setup.client.ts']
        }
      },
      {
        // Integration project: spawns a real `claude` subprocess via
        // tmux + FIFO + AgentRuntime. The tests internally `test.skipIf`
        // when `claude` is missing from PATH, so a `pnpm test` run on a
        // CI machine without the binary is silent — but local devs who
        // *do* have claude installed will still see the integration
        // tests run, which is the point. For an explicit, focused live
        // run use `pnpm test:integration`. See
        // docs/plans/v0.2-claude-code-status-detection-tests.md.
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.{test,spec}.ts'],
          // Real subprocess + API round-trip: keep the per-test budget
          // generous so first-token latency on Haiku doesn't trip the
          // gate when the local network is slow.
          testTimeout: 120_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
});
