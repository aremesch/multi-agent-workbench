/**
 * Idempotent singleton bootstrap called from hooks.server.ts (prod + dev)
 * and the dev WS vite plugin.
 *
 * Runs:
 *   1. Resolve config
 *   2. Initialize SQLite + run migrations
 *   3. Ensure a bootstrap user exists (single-user v0.1)
 *   4. Load cli-adapters/*.jsonc into AdapterRegistry + watch
 *   5. Create AgentSupervisor and reattach to surviving tmux sessions
 *
 * Guarded by a module-level `started` flag so HMR reloads don't double-init.
 */

import { ulid } from 'ulid';
import { getConfig } from './config.js';
import { getDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { countUsers, insertUser } from './db/queries.js';
import { AdapterRegistry } from './agents/adapters/AdapterRegistry.js';
import { AgentSupervisor } from './agents/AgentSupervisor.js';
import { PushService } from './push/PushService.js';
import { hashPassword } from './auth/password.js';
import { Tmux } from './tmux/TmuxSession.js';

// ---------- globalThis-backed singletons ----------
// In production the esbuild-bundled server.js and SvelteKit's chunk copy of
// this file are two separate module scopes with their own `let` variables.
// Using globalThis ensures whichever scope runs first wins; the second call
// is a no-op.
const G = globalThis as unknown as {
  __maw_started?: Promise<void>;
  __maw_supervisor?: AgentSupervisor;
  __maw_registry?: AdapterRegistry;
  __maw_push?: PushService;
};

export function bootstrap(): Promise<void> {
  if (G.__maw_started) return G.__maw_started;
  G.__maw_started = (async () => {
    const cfg = getConfig();
    console.log(`[maw] booting (dataDir=${cfg.dataDir}, isDev=${cfg.isDev})`);

    // 1. DB + migrations.
    getDb();
    const { applied, total } = runMigrations();
    console.log(`[maw] migrations: ${applied}/${total} applied`);

    // 2. Bootstrap user (single-user MVP).
    if (countUsers() === 0) {
      const hash = await hashPassword(cfg.bootstrapPassword);
      insertUser({
        id: ulid(),
        username: cfg.bootstrapUsername,
        password_hash: hash,
        must_change_password: true
      });
      console.log(
        `[maw] bootstrap user '${cfg.bootstrapUsername}' created — change password after first login`
      );
    }

    // 3. Push service (before supervisor so alerts can fire immediately).
    G.__maw_push = new PushService();
    G.__maw_push.init();

    // 4. Adapter registry.
    G.__maw_registry = new AdapterRegistry(cfg.cliAdaptersDir);
    const loadResult = G.__maw_registry.loadAll();
    console.log(`[maw] cli-adapters loaded: ${loadResult.loaded}`);
    for (const err of loadResult.errors) console.warn(`[maw] cli-adapter: ${err}`);
    G.__maw_registry.startWatching((kind) => console.log(`[maw] cli-adapter reloaded: ${kind}`));

    // 5. tmux server probe. In prod the dedicated maw-tmux.service user unit
    //    owns the `-L maw` server so it survives `systemctl --user restart maw`.
    //    See deploy/systemd/maw-tmux.service and README.
    await Tmux.assertServerRunning();

    // 6. Supervisor + reattach.
    G.__maw_supervisor = new AgentSupervisor(G.__maw_registry);
    const { reattached, crashed } = await G.__maw_supervisor.init();
    console.log(`[maw] supervisor: ${reattached} agents reattached, ${crashed} crashed`);

    // 6. Periodic reaper: scans every ~5s for runtimes whose tmux session
    //    has disappeared and flips them to `exited`. This is the slow-path
    //    safety net — the fast path is the per-agent session-closed hook
    //    installed in AgentSupervisor.startExitWatcher, which fires within
    //    milliseconds of a CLI exiting. The reaper still exists to catch
    //    edge cases the hook cannot (tmux server restart, hook lost on a
    //    reattach race, external `tmux kill-session`, …).
    //    The `started` guard in bootstrap() ensures we only schedule one
    //    interval per process even across HMR reloads in dev.
    const sup = G.__maw_supervisor;
    setInterval(() => {
      sup.reap().catch((err) => {
        console.error('[maw] supervisor: reap failed:', err);
      });
    }, REAP_INTERVAL_MS).unref();
  })();
  return G.__maw_started;
}

const REAP_INTERVAL_MS = 5000;

export function getSupervisor(): AgentSupervisor {
  if (!G.__maw_supervisor) {
    throw new Error('bootstrap() has not completed — getSupervisor() called too early');
  }
  return G.__maw_supervisor;
}

export function getRegistry(): AdapterRegistry {
  if (!G.__maw_registry) {
    throw new Error('bootstrap() has not completed — getRegistry() called too early');
  }
  return G.__maw_registry;
}

export function getPushService(): PushService {
  if (!G.__maw_push) {
    throw new Error('bootstrap() has not completed — getPushService() called too early');
  }
  return G.__maw_push;
}
