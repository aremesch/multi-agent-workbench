/**
 * Build smoke test: boot the bundled production server (`build/server.js`) in
 * a throwaway, isolated environment and assert it reaches the ready line
 * without crashing.
 *
 * Why this exists: the production server is a single esbuild bundle. A CJS
 * dependency that calls `require()` dynamically (jsdom via isomorphic-dompurify,
 * @kwsites/file-exists via simple-git, chromium-bidi via playwright, …) trips
 * esbuild's `__require2` shim and throws `Dynamic require of "X" is not
 * supported` at boot — a crash that only manifests in the bundle, never in
 * `vite dev` or vitest (both run against source). Nothing in CI used to boot
 * the bundle, so this class of regression reached production. This harness is
 * that missing check. See
 * docs/plans/v0.5-fix-production-server-boot-crash-dynamic-require-of-path-is.md.
 *
 * Isolation: a fresh empty MAW_DATA_DIR means the DB has zero agent rows, so
 * the supervisor reattaches nothing and cannot touch any real tmux session. A
 * unique MAW_TMUX_SOCKET is belt-and-suspenders on top of that.
 *
 * Exit 0 on success (ready line seen), non-zero on crash / early exit /
 * timeout. Runnable locally (`node scripts/smoke-boot.mjs`) and used by the
 * build-smoke CI workflow.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUNDLE = 'build/server.js';
const READY_LINE = '[maw] queue scheduler: started';
// esbuild's CJS-interop shim throws this exact phrase; `[maw] fatal:` is the
// entry point's top-level catch. Either during boot is a hard failure.
const FATAL_PATTERNS = [/Dynamic require of/i, /\[maw\] fatal:/];
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);

if (!existsSync(BUNDLE)) {
  console.error(`[smoke] ${BUNDLE} not found — run \`pnpm build\` first.`);
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), 'maw-smoke-'));
const env = {
  ...process.env,
  PORT: process.env.SMOKE_PORT ?? '4271',
  HOST: '127.0.0.1',
  MAW_DATA_DIR: dataDir,
  MAW_WORKTREE_ROOT: join(dataDir, 'worktrees'),
  MAW_FIFO_DIR: join(dataDir, 'fifos'),
  MAW_AUTH_LOG_PATH: join(dataDir, 'auth.log'),
  MAW_SESSION_SECRET: 'smoke-secret-not-for-prod',
  // Dedicated socket so we can never reattach to / reap a real agent session.
  MAW_TMUX_SOCKET: `maw-smoke-${process.pid}`,
  UV_THREADPOOL_SIZE: '64'
};

const child = spawn('node', [BUNDLE], { env, stdio: ['ignore', 'pipe', 'pipe'] });

let settled = false;
let output = '';

function cleanup() {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2500).unref();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function finish(code, msg) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  (code === 0 ? console.log : console.error)(msg);
  cleanup();
  // Let the SIGTERM flush through the server's graceful-shutdown log first.
  setTimeout(() => process.exit(code), 300).unref();
}

const timer = setTimeout(
  () => finish(1, `[smoke] FAIL: no "${READY_LINE}" within ${TIMEOUT_MS}ms`),
  TIMEOUT_MS
);

function scan(buf, mirror) {
  const text = buf.toString();
  output += text;
  mirror.write(text); // surface the server's own logs in CI output
  for (const re of FATAL_PATTERNS) {
    if (re.test(output)) {
      finish(1, `[smoke] FAIL: server emitted ${re} during boot`);
      return;
    }
  }
  if (output.includes(READY_LINE)) {
    finish(0, `[smoke] PASS: server reached "${READY_LINE}" cleanly`);
  }
}

child.stdout.on('data', (b) => scan(b, process.stdout));
child.stderr.on('data', (b) => scan(b, process.stderr));
child.on('error', (err) => finish(1, `[smoke] FAIL: could not spawn server: ${err.message}`));
child.on('exit', (code, signal) => {
  if (settled) return; // our own shutdown
  finish(1, `[smoke] FAIL: server exited before ready (code=${code}, signal=${signal})`);
});
