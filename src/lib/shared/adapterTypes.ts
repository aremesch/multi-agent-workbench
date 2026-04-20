/**
 * CLI adapter contract — imported by both client and server.
 * No runtime dependencies so it can cross the client/server boundary safely.
 */

export type CliKind = string;

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Optional text to type into the pane after the CLI is ready. */
  initialInput?: string;
}

export type AdapterEventKind =
  | 'ready'
  | 'working'
  | 'prompt_detected'
  | 'task_done'
  | 'error'
  | 'exited';

export interface AdapterEvent {
  kind: AdapterEventKind;
  at: number;
  patternId?: string;
  choices?: string[];
  detail?: Record<string, unknown>;
  raw?: string;
  /** Tagged when the event came from replay of tmux scrollback on reattach. */
  replay?: boolean;
}

export interface InputEncoding {
  encode(text: string): string[];
  answerPrompt(choice: string | number): string[];
}

export type AdapterRuntimeState =
  | 'BOOTING'
  | 'READY'
  | 'WORKING'
  | 'WAITING_PROMPT'
  | 'IDLE'
  | 'EXITED';

/**
 * How the hub should build a reconnect snapshot for an agent using this
 * adapter. See `adapter.config.schema.ts` for the full rationale — the
 * short version is: TUI CLIs want `'visible'` (drop scrollback ghosts),
 * line-based CLIs want `'history'` (keep real backlog, deduped).
 */
export type ScrollbackMode = 'visible' | 'history';

/**
 * Out-of-band history reader hint. Tmux scrollback is the *terminal* state;
 * `historySource` points at the CLI's own structured transcript so the
 * reconnect snapshot can prepend real conversation history (as opposed to
 * repaint ghosts). `kind` discriminates the parser; concrete shape lives in
 * the corresponding reader module (e.g. ClaudeJsonlHistory for `claude-jsonl`).
 */
export interface HistorySourceSpec {
  kind: 'claude-jsonl';
}

export interface BuildSpawnSpecOpts {
  role: { systemPrompt: string; toolConfig: unknown };
  worktreeCwd: string;
  task: { title: string; body: string } | null;
  env: Record<string, string>;
  /** Identity vars exposed to adapter `{{agent.*}}` template substitutions. */
  agent: { id: string; cliSessionId: string | null };
  /** Per-spawn toggle overrides keyed by optionalArg id. */
  optionalArgs?: Record<string, boolean>;
}

export interface CliAdapter {
  kind: CliKind;
  displayName: string;
  /** Reconnect snapshot strategy — see {@link ScrollbackMode}. */
  readonly scrollbackMode: ScrollbackMode;
  /** Optional structured history source — see {@link HistorySourceSpec}. */
  readonly historySource: HistorySourceSpec | null;
  /**
   * When true, the hub performs a 1-cell resize dance after shipping the
   * reconnect snapshot so the CLI sees a SIGWINCH and fully repaints at the
   * viewer's dims. Intended for TUI CLIs whose scrollback snapshot alone
   * leaves the viewer with a frozen frame; line-based CLIs leave this false.
   */
  readonly forceRedrawOnReconnect: boolean;
  buildSpawnSpec(opts: BuildSpawnSpecOpts): SpawnSpec;
  ingest(chunk: Buffer): AdapterEvent[];
  input: InputEncoding;
  state(): AdapterRuntimeState;
  isIdleWaiting(): boolean;
}
