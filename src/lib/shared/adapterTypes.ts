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
 * One key-chord button rendered under xterm on touch devices. `keys` is sent
 * verbatim via the existing `send_keys` WS path — same channel as keystrokes
 * out of `term.onData`. Typical values are VT escape sequences (e.g.
 * `"\u001b[A"` for cursor up). See `mobileQuickKeySchema` for validation.
 */
export interface MobileQuickKey {
  id: string;
  label: string;
  keys: string;
}

export interface BuildSpawnSpecOpts {
  role: { systemPrompt: string; toolConfig: unknown };
  worktreeCwd: string;
  task: { title: string; body: string } | null;
  env: Record<string, string>;
  /** Identity vars exposed to adapter `{{agent.*}}` template substitutions. */
  agent: { id: string; cliSessionId?: string | null };
  /** Per-spawn toggle overrides keyed by optionalArg id. */
  optionalArgs?: Record<string, boolean>;
  /**
   * Per-spawn value picks for the adapter's `capabilities.*` selectors.
   * Keyed by capability name (currently `model`, `permissionMode`). Each
   * value is the id of one option from `capability.values`. Absent / null
   * means "use the capability's `default`". Substituted into the
   * capability's `arg` template under `{{value}}` and appended to argv.
   */
  capabilityValues?: Record<string, string | null | undefined>;
}

export interface CliAdapter {
  kind: CliKind;
  displayName: string;
  /**
   * Whether spawning an agent of this kind should create a dedicated git
   * worktree. Defaults to true; set false for adapters that run in the repo
   * root on whatever branch is already checked out. See adapter.config.schema.ts.
   */
  readonly createWorktree: boolean;
  /**
   * On-screen key-chord buttons to render under xterm on touch devices (or
   * when the user forces them on via settings). Empty array = adapter opted
   * out; the UI just hides the row. See {@link MobileQuickKey}.
   */
  readonly mobileQuickKeys: MobileQuickKey[];
  /**
   * True if any spawn-config string references `{{agent.cliSessionId}}` —
   * the signal AgentSupervisor uses to mint and persist a UUID that will
   * be both fed to the CLI (e.g. `claude --session-id <uuid>`) and stored
   * in `agents.cli_session_id` so JSONL transcript paths are reproducible.
   */
  readonly needsCliSessionId: boolean;
  buildSpawnSpec(opts: BuildSpawnSpecOpts): SpawnSpec;
  ingest(chunk: Buffer): AdapterEvent[];
  input: InputEncoding;
  state(): AdapterRuntimeState;
  isIdleWaiting(): boolean;
}
