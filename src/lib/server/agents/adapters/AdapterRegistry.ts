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

  list(): { kind: string; displayName: string }[] {
    return Array.from(this.entries.values()).map((e) => ({
      kind: e.config.kind,
      displayName: e.config.displayName
    }));
  }

  /** Build a new adapter instance for a kind. Each agent gets its own. */
  create(kind: string): CliAdapter {
    const entry = this.entries.get(kind);
    if (!entry) throw new Error(`unknown cli_kind: ${kind}`);
    return new ConfigDrivenAdapter(entry.config);
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
