/**
 * ConfigDrivenAdapter — one concrete CliAdapter implementation, driven by a
 * validated AdapterConfig.
 *
 * Behavior (per plan §CLI adapter interface / §Config-driven CLI adapters):
 *   1. Hold compiled RegExp objects for each pattern (compiled once at load).
 *   2. Maintain an ANSI-stripped rolling tail buffer (default 8 KB).
 *   3. On ingest(chunk): append, strip, slide, scan top-to-bottom, emit
 *      AdapterEvents with patternId / choices / detail (named groups).
 *   4. Track an explicit state-machine enum driven by pattern kinds.
 *   5. buildSpawnSpec interpolates {{...}} variables (no-logic substitution).
 *   6. input.encode / input.answerPrompt consult the config's `input` block.
 */

import stripAnsi from 'strip-ansi';
import type {
  AdapterEvent,
  AdapterRuntimeState,
  BuildSpawnSpecOpts,
  CliAdapter,
  InputEncoding,
  MobileQuickKey,
  SpawnSpec
} from '$shared/adapterTypes';
import type { AdapterConfig, AdapterPatternConfig } from './adapter.config.schema.js';

const TAIL_MAX_BYTES = 8 * 1024;

interface CompiledPattern {
  cfg: AdapterPatternConfig;
  re: RegExp;
}

export class ConfigDrivenAdapter implements CliAdapter {
  readonly kind: string;
  readonly displayName: string;
  readonly createWorktree: boolean;
  readonly mobileQuickKeys: MobileQuickKey[];
  readonly input: InputEncoding;

  private readonly cfg: AdapterConfig;
  private readonly patterns: CompiledPattern[];
  private tail = '';
  private _state: AdapterRuntimeState = 'BOOTING';
  private lastOutputAt = 0;

  /** Tracks last matched text per alert-producing pattern to prevent re-firing
   *  on stale content that is still sitting in the tail buffer. */
  private firedMatches = new Map<string, string>();

  constructor(cfg: AdapterConfig) {
    this.cfg = cfg;
    this.kind = cfg.kind;
    this.displayName = cfg.displayName;
    this.createWorktree = cfg.createWorktree;
    this.mobileQuickKeys = cfg.mobileQuickKeys;
    this.patterns = cfg.patterns.map((p) => ({
      cfg: p,
      re: new RegExp(p.regex, p.flags ?? '')
    }));

    const ic = cfg.input;
    this.input = {
      encode: (text: string): string[] => {
        // encoding: 'literal' — hand text over untouched; TmuxSession applies
        // `send-keys -l -- <text>` then a separate submitKey press.
        return text.length === 0 ? [] : [text];
      },
      answerPrompt: (choice: string | number): string[] => {
        const key = String(choice);
        const preset = ic.promptAnswers[key];
        if (preset) return preset;
        // Fall back to literal + Enter.
        return [key, ic.submitKey];
      }
    };
  }

  state(): AdapterRuntimeState {
    return this._state;
  }

  isIdleWaiting(): boolean {
    if (this._state === 'WAITING_PROMPT') return true;
    if (this._state !== 'WORKING' && this._state !== 'IDLE') return false;

    const idle = this.cfg.idleDetection;
    if (idle.method === 'inactivity') {
      if (!this.lastOutputAt) return false;
      return Date.now() - this.lastOutputAt >= idle.inactivityMs;
    }
    if (idle.method === 'cursor_at_prompt' && idle.promptLineRegex) {
      const lastLine = this.lastNonEmptyLine(this.tail);
      try {
        return new RegExp(idle.promptLineRegex).test(lastLine);
      } catch {
        return false;
      }
    }
    return false;
  }

  ingest(chunk: Buffer): AdapterEvent[] {
    const now = Date.now();
    this.lastOutputAt = now;

    const stripped = stripAnsi(chunk.toString('utf8'));
    this.tail = (this.tail + stripped).slice(-TAIL_MAX_BYTES);

    // Evict stale fired-match entries whose text scrolled out of the tail.
    for (const [id, text] of this.firedMatches) {
      if (!this.tail.includes(text)) this.firedMatches.delete(id);
    }

    const events: AdapterEvent[] = [];
    for (const p of this.patterns) {
      const scope = p.cfg.scope === 'tail_line' ? this.lastNonEmptyLine(this.tail) : this.tail;
      const m = p.re.exec(scope);
      if (!m) continue;

      // Deduplicate alert-producing patterns: skip if the exact same text
      // is still in the tail from a previous match. State-tracking kinds
      // (ready, working) must re-fire for the state machine.
      const isAlertKind = p.cfg.kind === 'prompt_detected'
        || p.cfg.kind === 'error'
        || p.cfg.kind === 'task_done';
      if (isAlertKind && this.firedMatches.get(p.cfg.id) === m[0]) continue;
      if (isAlertKind) this.firedMatches.set(p.cfg.id, m[0]);

      const detail: Record<string, unknown> = { ...(m.groups ?? {}) };
      const ev: AdapterEvent = {
        kind: p.cfg.kind,
        at: now,
        patternId: p.cfg.id,
        detail,
        raw: m[0]
      };
      if (p.cfg.choices) ev.choices = p.cfg.choices;

      // Advance the state machine. Later patterns in the same ingest may
      // supersede (e.g. ready → working) — last-matching kind wins for state.
      this.advanceState(p.cfg.kind);
      events.push(ev);
    }

    // If we saw any output without matching a pattern, and we were BOOTING,
    // assume we're WORKING — a cheap but useful heuristic for configs that
    // don't bother defining a `working` pattern.
    if (events.length === 0 && this._state === 'BOOTING') {
      this._state = 'WORKING';
    }

    return events;
  }

  buildSpawnSpec(opts: BuildSpawnSpecOpts): SpawnSpec {
    const vars: Record<string, string> = {
      worktree: opts.worktreeCwd,
      'role.systemPrompt': opts.role.systemPrompt ?? '',
      'role.toolConfig': JSON.stringify(opts.role.toolConfig ?? {}),
      'task.title': opts.task?.title ?? '',
      'task.body': opts.task?.body ?? '',
      'agent.id': opts.agent.id
    };
    for (const [k, v] of Object.entries(opts.env)) {
      vars[`env.${k}`] = v;
    }

    const subst = (s: string): string =>
      s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');

    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.cfg.spawn.env)) {
      resolvedEnv[k] = subst(v);
    }

    const args = this.cfg.spawn.args.map(subst);

    // Merge optional args: user overrides → adapter defaults.
    for (const opt of this.cfg.spawn.optionalArgs) {
      const enabled = opts.optionalArgs?.[opt.id] ?? opt.default;
      if (enabled) {
        args.push(opt.flag);
      }
    }

    const spec: SpawnSpec = {
      command: subst(this.cfg.spawn.command),
      args,
      env: resolvedEnv,
      cwd: opts.worktreeCwd
    };
    if (this.cfg.spawn.initialInput !== undefined) {
      spec.initialInput = subst(this.cfg.spawn.initialInput);
    }
    return spec;
  }

  // ---------- helpers ----------

  private advanceState(kind: AdapterEvent['kind']): void {
    switch (kind) {
      case 'ready':
        this._state = 'READY';
        break;
      case 'working':
        this._state = 'WORKING';
        break;
      case 'prompt_detected':
        this._state = 'WAITING_PROMPT';
        break;
      case 'task_done':
        this._state = 'IDLE';
        break;
      case 'exited':
        this._state = 'EXITED';
        break;
      // 'error' doesn't transition state by itself
    }
  }

  private lastNonEmptyLine(s: string): string {
    const lines = s.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line !== undefined && line.trim().length > 0) return line;
    }
    return '';
  }
}
