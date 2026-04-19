/**
 * Production entry.
 *
 * adapter-node emits `build/handler.js` which is the SvelteKit request
 * handler. We wrap it in our own http.Server so we can also mount the `ws`
 * server on the same listener at '/ws'.
 *
 * At build time `pnpm build` runs `vite build` (SvelteKit) followed by
 * `esbuild` which bundles this file + all src/lib/server/** TypeScript into
 * `build/server.js`. Native addons (better-sqlite3, @node-rs/argon2) and
 * the SvelteKit handler are kept external.
 *
 * To launch: `node build/server.js`
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { handler } from './build/handler.js';
import { bootstrap, getSupervisor } from './src/lib/server/bootstrap.ts';
import { getWsHub } from './src/lib/server/ws/hub.ts';

async function main() {
  await bootstrap();

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';

  // Wrap the SvelteKit handler so `/ws` never reaches the router — it
  // belongs exclusively to the `upgrade` event below.  Without this guard
  // a reverse proxy that strips the `Upgrade` header (common nginx/caddy
  // misconfiguration) would forward a plain `GET /ws` into SvelteKit,
  // which logs a noisy 404 and confuses debugging.
  const server = http.createServer((req, res) => {
    if (req.url === '/ws' || req.url?.startsWith('/ws?')) {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end(
        'WebSocket upgrade required. If you are behind a reverse proxy, ' +
        'make sure it forwards Upgrade and Connection headers.'
      );
      return;
    }
    handler(req, res);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        getWsHub().attach(ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  server.listen(port, host, () => {
    console.log(`[maw] listening on http://${host}:${port}`);
  });

  // Graceful shutdown: let tmux sessions keep running; just close listeners.
  // Latch the supervisor into shutdown mode *first* so the periodic reaper
  // stops writing `exited` to DB rows. Under systemd's default
  // `KillMode=control-group` every child of node (including tmux CLI
  // invocations) gets SIGTERM'd in parallel with us; without the latch a
  // reap() call in flight would see list-sessions fail, conclude all
  // sessions died, and orphan every agent.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`[maw] received ${sig}, shutting down`);
      try { getSupervisor().markShuttingDown(); } catch { /* bootstrap not done */ }
      server.close(() => process.exit(0));
      // Fail-safe: if connections keep us alive past systemd's
      // TimeoutStopSec we'd get SIGKILL'd anyway; exit promptly.
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

main().catch((err) => {
  console.error('[maw] fatal:', err);
  process.exit(1);
});
