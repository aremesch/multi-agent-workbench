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

export interface CliAdapter {
  kind: CliKind;
  displayName: string;
  buildSpawnSpec(opts: {
    role: { systemPrompt: string; toolConfig: unknown };
    worktreeCwd: string;
    task: { title: string; body: string } | null;
    env: Record<string, string>;
  }): SpawnSpec;
  ingest(chunk: Buffer): AdapterEvent[];
  input: InputEncoding;
  state(): AdapterRuntimeState;
  isIdleWaiting(): boolean;
}
