/**
 * Internal hook receiver for Claude Code agents.
 *
 * Each claude-code spawn writes a `.claude/settings.local.json` into its
 * worktree that registers `Notification` and `PreToolUse` hooks. Those
 * hooks run a `curl` POST to this route on every event, with a per-agent
 * bearer token in `Authorization`. The structured JSON Claude Code emits
 * (see https://code.claude.com/docs/en/hooks.md) is forwarded as-is.
 *
 * Security: defence-in-depth.
 *   1. Loopback-only — `getClientAddress()` must be 127.0.0.1 or ::1.
 *      The hook curl runs in the agent's tmux on the same machine, so
 *      legitimate traffic is always loopback. Any non-loopback caller is
 *      either misconfigured or hostile and gets 403.
 *   2. Bearer token — the token is generated cryptographically random
 *      at spawn (`generateHookToken` → 32 bytes hex), unique per agent,
 *      and stored on `agents.hook_token`. Unknown tokens get 401.
 *
 * Both checks are performed before any work happens. The route always
 * responds quickly (target < 100 ms) because Claude Code waits for the
 * hook command to exit before showing the prompt to the human.
 */

import type { RequestHandler } from './$types';
import { getAgentByHookToken } from '$lib/server/db/queries';
import { getSupervisor } from '$lib/server/bootstrap';

const LOOPBACK_ADDRS = new Set([
  '127.0.0.1',
  '::1',
  // Node sometimes reports loopback IPv4 wrapped in IPv6:
  '::ffff:127.0.0.1'
]);

const MAX_BODY_BYTES = 64 * 1024;

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  // 1. Loopback gate.
  let addr = '';
  try {
    addr = getClientAddress();
  } catch {
    addr = '';
  }
  if (!LOOPBACK_ADDRS.has(addr)) {
    return new Response('forbidden', { status: 403 });
  }

  // 2. Bearer token.
  const auth = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const token = (m && m[1] ? m[1].trim() : '');
  if (!token) return new Response('unauthorized', { status: 401 });

  const agent = getAgentByHookToken(token);
  if (!agent) return new Response('unauthorized', { status: 401 });

  // 3. Body. Hook events are small (~1 KB typical); cap to defend
  // against accidental misuse — `--data-binary @-` will read whatever
  // stdin Claude Code provides.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return new Response('payload too large', { status: 413 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // 4. Route to the live runtime. No-op (still 204) if the runtime is
  //    gone — a curl arriving microseconds after the agent exited is a
  //    benign race, not an error.
  try {
    getSupervisor().ingestClaudeHook(agent.id, payload);
  } catch (err) {
    // Don't leak internals; Claude Code will block the prompt until we
    // respond, so 500 here would prevent the user from seeing the prompt
    // at all. Swallow + log.
    console.warn('[claude-hook] ingest threw:', err);
  }

  return new Response(null, { status: 204 });
};
