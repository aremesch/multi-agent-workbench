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

export const PROTOCOL_VERSION = 1;

// ---------- client → server ----------

export interface CS_Hello {
  type: 'hello';
  clientVersion: number;
}
export interface CS_SubscribeAgent {
  type: 'subscribe_agent';
  agentId: string;
  /** Last seq the client has seen; server will gap-replay from here. */
  lastSeq?: number;
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

export type ClientMessage =
  | CS_Hello
  | CS_SubscribeAgent
  | CS_UnsubscribeAgent
  | CS_SendInput
  | CS_AnswerPrompt
  | CS_AssignTask
  | CS_Control
  | CS_Ping;

// ---------- server → client ----------

export interface SC_Welcome {
  type: 'welcome';
  serverVersion: number;
  userId: string;
}
export interface SC_Scrollback {
  type: 'scrollback';
  agentId: string;
  chunks: { seq: number; b64: string }[];
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
  | SC_Scrollback
  | SC_Output
  | SC_AgentEvent
  | SC_AgentState
  | SC_Alert
  | SC_Message
  | SC_Ack
  | SC_Error
  | SC_Pong;
