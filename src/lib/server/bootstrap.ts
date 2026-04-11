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
import { hashPassword } from './auth/password.js';

let started: Promise<void> | null = null;
let supervisor: AgentSupervisor | null = null;
let registry: AdapterRegistry | null = null;

export function bootstrap(): Promise<void> {
  if (started) return started;
  started = (async () => {
    const cfg = getConfig();
    console.log(`[maw] booting (dataDir=${cfg.dataDir}, isDev=${cfg.isDev})`);

    // 1. DB + migrations.
    getDb();
    const { applied, total } = runMigrations();
    console.log(`[maw] migrations: ${applied}/${total} applied`);

    // 2. Bootstrap user (single-user MVP).
    if (countUsers() === 0) {
      const hash = await hashPassword(cfg.bootstrapPassword);
      insertUser({ id: ulid(), username: cfg.bootstrapUsername, password_hash: hash });
      console.log(
        `[maw] bootstrap user '${cfg.bootstrapUsername}' created — change password after first login`
      );
    }

    // 3. Adapter registry.
    registry = new AdapterRegistry(cfg.cliAdaptersDir);
    const loadResult = registry.loadAll();
    console.log(`[maw] cli-adapters loaded: ${loadResult.loaded}`);
    for (const err of loadResult.errors) console.warn(`[maw] cli-adapter: ${err}`);
    registry.startWatching((kind) => console.log(`[maw] cli-adapter reloaded: ${kind}`));

    // 4. Supervisor + reattach.
    supervisor = new AgentSupervisor(registry);
    const { reattached, crashed } = await supervisor.init();
    console.log(`[maw] supervisor: ${reattached} agents reattached, ${crashed} crashed`);
  })();
  return started;
}

export function getSupervisor(): AgentSupervisor {
  if (!supervisor) {
    throw new Error('bootstrap() has not completed — getSupervisor() called too early');
  }
  return supervisor;
}

export function getRegistry(): AdapterRegistry {
  if (!registry) {
    throw new Error('bootstrap() has not completed — getRegistry() called too early');
  }
  return registry;
}
