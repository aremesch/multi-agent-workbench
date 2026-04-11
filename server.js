/**
 * Production entry.
 *
 * adapter-node emits `build/handler.js` which is the SvelteKit request
 * handler. We wrap it in our own http.Server so we can also mount the `ws`
 * server on the same listener at '/ws'.
 *
 * The bootstrap singleton lives in TypeScript source — in production we run
 * this file via `tsx server.js` (strictly speaking tsx doesn't do .js → .ts,
 * but `import('./src/lib/server/bootstrap.ts')` works when invoked via
 * `tsx server.js`). For pure-Node deployments without tsx, install
 * `@esbuild-kit/esm-loader` or bundle the bootstrap separately.
 *
 * To launch: `node --import tsx server.js`  OR  `tsx server.js`.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { handler } from './build/handler.js';
// These imports resolve via tsx's TS loader at runtime.
// eslint-disable-next-line import/extensions
import { bootstrap } from './src/lib/server/bootstrap.ts';
// eslint-disable-next-line import/extensions
import { getWsHub } from './src/lib/server/ws/hub.ts';

async function main() {
  await bootstrap();

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';

  const server = http.createServer(handler);
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
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`[maw] received ${sig}, shutting down`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[maw] fatal:', err);
  process.exit(1);
});
