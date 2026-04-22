/**
 * WebSocket protocol union — the fe↔be contract for /ws.
 *
 * Client → Server and Server → Client messages are discriminated on `type`.
 * Terminal byte chunks travel as base64 so the whole envelope stays JSON.
 *
 * Versioning: bump PROTOCOL_VERSION on breaking changes; ws.ts reconnects
 * hard if the server reports a mismatched version in the first hello.
 */

import type { AdapterEventKind } from './adapterTypes.js';

export const PROTOCOL_VERSION = 5;

// ---------- client → server ----------

export interface CS_Hello {
  type: 'hello';
  clientVersion: number;
}
export interface CS_SubscribeAgent {
  type: 'subscribe_agent';
  agentId: string;
}
export interface CS_UnsubscribeAgent {
  type: 'unsubscribe_agent';
  agentId: string;
}
export interface CS_SendInput {
  type: 'send_input';
  agentId: string;
  text: string;
  submit: boolean;
}
export interface CS_SendKeys {
  // Raw keystroke bytes (e.g. arrow keys, Ctrl-C) forwarded from the xterm.js
  // `onData` callback. Distinct from `send_input`, which is line-mode text +
  // an optional Enter.
  type: 'send_keys';
  agentId: string;
  b64: string;
}
export interface CS_AnswerPrompt {
  type: 'answer_prompt';
  agentId: string;
  choice: string | number;
}
export interface CS_AssignTask {
  type: 'assign_task';
  agentId: string;
  task: { title: string; body: string };
}
export interface CS_Control {
  type: 'control';
  agentId: string;
  action: 'stop' | 'sigint' | 'restart';
}
export interface CS_Ping {
  type: 'ping';
  ts: number;
}
/**
 * Resize the underlying tmux pane so its column/row count matches the
 * xterm.js window the user is looking at. Sent on terminal mount and
 * (debounced) on every subsequent xterm resize. Keeping the two in sync
 * is the only way to avoid CLI output wrapping at an unrelated column.
 */
export interface CS_Resize {
  type: 'resize';
  agentId: string;
  cols: number;
  rows: number;
}

export type ClientMessage =
  | CS_Hello
  | CS_SubscribeAgent
  | CS_UnsubscribeAgent
  | CS_SendInput
  | CS_SendKeys
  | CS_AnswerPrompt
  | CS_AssignTask
  | CS_Control
  | CS_Ping
  | CS_Resize;

// ---------- server → client ----------

export interface SC_Welcome {
  type: 'welcome';
  serverVersion: number;
  userId: string;
}
/**
 * Reconnect snapshot. Sent once in response to `subscribe_agent`, carrying
 * the tmux pane's currently rendered grid as ANSI (from `capture-pane -p
 * -e -S 0`). Clients `term.reset()` before writing `ansi` so the paint
 * always lands on a clean grid — no redraw-bursting replay. `seq` is the
 * `terminal_log.seq` watermark at capture time; after applying the
 * snapshot the client sets its dedup cursor to this value so live `output`
 * frames with `seq > snapshotSeq` paint on top without duplication and
 * any catch-up re-emits (bytes that slipped past during the capture-pane
 * await) are re-applied once.
 */
export interface SC_PaneSnapshot {
  type: 'pane_snapshot';
  agentId: string;
  ansi: string;
  seq: number;
}
export interface SC_Output {
  type: 'output';
  agentId: string;
  seq: number;
  b64: string;
}
export interface SC_AgentEvent {
  type: 'event';
  agentId: string;
  kind: AdapterEventKind;
  patternId?: string;
  choices?: string[];
  detail?: Record<string, unknown>;
}
export interface SC_AgentState {
  type: 'agent_state';
  agentId: string;
  status: string;
}
export interface SC_Alert {
  type: 'alert';
  id: string;
  agentId: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  reason: string;
  payload?: Record<string, unknown>;
  ts: number;
}
export interface SC_Message {
  type: 'message';
  id: string;
  fromAgentId: string | null;
  toAgentId: string;
  body: string;
  ts: number;
}
export interface SC_Ack {
  type: 'ack';
  ref: string;
}
export interface SC_Error {
  type: 'error';
  code: string;
  message: string;
}
export interface SC_Pong {
  type: 'pong';
  ts: number;
}

export type ServerMessage =
  | SC_Welcome
  | SC_PaneSnapshot
  | SC_Output
  | SC_AgentEvent
  | SC_AgentState
  | SC_Alert
  | SC_Message
  | SC_Ack
  | SC_Error
  | SC_Pong;
