/**
 * AdapterRegistry — loads cli-adapters/*.jsonc, validates via Zod, and
 * exposes factories to build ConfigDrivenAdapter instances per agent.
 *
 * Hot reload (dev + prod) is handled via chokidar; an in-flight agent keeps
 * its own instance (constructed from a snapshot), so changes only affect
 * new agent spawns.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import chokidar, { type FSWatcher } from 'chokidar';
import { adapterConfigSchema, type AdapterConfig } from './adapter.config.schema.js';
import { ConfigDrivenAdapter } from './ConfigDrivenAdapter.js';
import type { CliAdapter } from '$shared/adapterTypes';

interface LoadedEntry {
  config: AdapterConfig;
  sourcePath: string;
  loadedAt: number;
}

/**
 * Public-facing description of one loaded adapter, returned from `list()`.
 * Surfaces every piece of UI-relevant metadata the spawn dialog needs to
 * decide which fields to render. Kept in this file (rather than a shared
 * type) because consumers are server-side `+page.server.ts` loaders that
 * import the registry directly; the client receives this via SvelteKit's
 * structured-clone serializer.
 */
export interface AdapterCapabilityValue {
  id: string;
  label: string;
}
export interface AdapterCapabilityListing {
  label: string;
  values: AdapterCapabilityValue[];
  default: string | null;
}
export interface AdapterListing {
  kind: string;
  displayName: string;
  createWorktree: boolean;
  acceptsImageAttachment: boolean;
  initialInputDelivery: 'none' | 'cli-arg';
  optionalArgs: Array<{
    id: string;
    flag: string;
    label: string;
    description?: string;
    default: boolean;
  }>;
  mobileQuickKeys: Array<{ id: string; label: string; keys: string }>;
  capabilities: {
    model: AdapterCapabilityListing | null;
    permissionMode: AdapterCapabilityListing | null;
  };
}

export class AdapterRegistry {
  private entries = new Map<string, LoadedEntry>();
  private watcher: FSWatcher | null = null;

  constructor(private readonly dir: string) {}

  loadAll(): { loaded: number; errors: string[] } {
    const errors: string[] = [];
    this.entries.clear();

    if (!existsSync(this.dir)) {
      return { loaded: 0, errors: [`cli-adapters dir not found: ${this.dir}`] };
    }

    const files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonc') || f.endsWith('.json'));

    for (const file of files) {
      const path = join(this.dir, file);
      try {
        const entry = this.loadFile(path);
        if (this.entries.has(entry.config.kind)) {
          errors.push(
            `duplicate adapter kind '${entry.config.kind}' in ${file} (already loaded)`
          );
          continue;
        }
        this.entries.set(entry.config.kind, entry);
      } catch (err) {
        errors.push(`${file}: ${(err as Error).message}`);
      }
    }

    return { loaded: this.entries.size, errors };
  }

  /** Start watching the directory; reloads files on change. */
  startWatching(onReload?: (kind: string) => void): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(`${this.dir}/*.{jsonc,json}`, { ignoreInitial: true });
    const reload = (path: string): void => {
      try {
        const entry = this.loadFile(path);
        this.entries.set(entry.config.kind, entry);
        onReload?.(entry.config.kind);
      } catch (err) {
        console.error(`[AdapterRegistry] reload failed ${path}: ${(err as Error).message}`);
      }
    };
    this.watcher.on('add', reload);
    this.watcher.on('change', reload);
    this.watcher.on('unlink', (path) => {
      for (const [kind, entry] of this.entries) {
        if (entry.sourcePath === path) this.entries.delete(kind);
      }
    });
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  has(kind: string): boolean {
    return this.entries.has(kind);
  }

  list(): AdapterListing[] {
    return Array.from(this.entries.values()).map((e) => {
      const caps = e.config.capabilities ?? {};
      return {
        kind: e.config.kind,
        displayName: e.config.displayName,
        createWorktree: e.config.createWorktree,
        acceptsImageAttachment: e.config.acceptsImageAttachment,
        initialInputDelivery: e.config.spawn.initialInput.delivery,
        optionalArgs: e.config.spawn.optionalArgs.map((o) => ({
          id: o.id,
          flag: o.flag,
          label: o.label,
          description: o.description,
          default: o.default
        })),
        mobileQuickKeys: e.config.mobileQuickKeys.map((k) => ({
          id: k.id,
          label: k.label,
          keys: k.keys
        })),
        capabilities: {
          model: caps.model
            ? {
                label: caps.model.label,
                values: caps.model.values.map((v) => ({ id: v.id, label: v.label })),
                default: caps.model.default ?? null
              }
            : null,
          permissionMode: caps.permissionMode
            ? {
                label: caps.permissionMode.label,
                values: caps.permissionMode.values.map((v) => ({
                  id: v.id,
                  label: v.label
                })),
                default: caps.permissionMode.default ?? null
              }
            : null
        }
      };
    });
  }

  /** Build a new adapter instance for a kind. Each agent gets its own. */
  create(kind: string): CliAdapter {
    const entry = this.entries.get(kind);
    if (!entry) throw new Error(`unknown cli_kind: ${kind}`);
    return new ConfigDrivenAdapter(entry.config);
  }

  /** Adapter-declared opt-out of per-agent worktree creation. Defaults true
   *  when the kind is unknown (defensive — caller already validated). */
  shouldCreateWorktree(kind: string): boolean {
    const entry = this.entries.get(kind);
    return entry?.config.createWorktree ?? true;
  }

  // ---------- internals ----------

  private loadFile(path: string): LoadedEntry {
    const raw = readFileSync(path, 'utf8');
    const errors: import('jsonc-parser').ParseError[] = [];
    const parsed: unknown = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0]!;
      throw new Error(
        `JSONC parse error at offset ${first.offset}: ${printParseErrorCode(first.error)}`
      );
    }
    const result = adapterConfigSchema.safeParse(parsed);
    if (!result.success) {
      const msg = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`schema validation failed: ${msg}`);
    }

    // Compile every regex up front so malformed patterns fail at load, not run time.
    for (const p of result.data.patterns) {
      try {
        new RegExp(p.regex, p.flags ?? '');
      } catch (err) {
        throw new Error(`invalid regex in pattern '${p.id}': ${(err as Error).message}`);
      }
    }

    return { config: result.data, sourcePath: path, loadedAt: Date.now() };
  }
}
