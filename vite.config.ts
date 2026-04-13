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
    include: ['src/**/*.{test,spec}.{js,ts}']
  }
});
