/// <reference types="vitest" />
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

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

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), devWebSocketPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173
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
        // without false alarms on CI jitter. Phase 8 added MawWsClient
        // coverage (src/lib/client at ~88.0% line / ~86.9% branch /
        // ~94.1% function).
        lines: 32,
        branches: 86,
        functions: 69,
        statements: 32
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
            'src/lib/shared/**/*.{test,spec}.ts'
          ]
        }
      },
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          include: [
            'src/lib/client/**/*.{test,spec}.ts',
            'src/lib/components/**/*.{test,spec}.ts',
            'src/routes/**/*.{test,spec}.ts'
          ],
          setupFiles: ['tests/unit/setup.client.ts']
        }
      }
    ]
  }
});
