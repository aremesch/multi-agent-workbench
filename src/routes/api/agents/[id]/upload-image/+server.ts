/**
 * POST /api/agents/:id/upload-image
 *
 * Multipart upload (single field `file`) that writes the image into the
 * agent's worktree at `.maw/uploads/<gen>.<ext>` and returns the
 * relative path. The client then types ` @<path> ` into the agent's
 * tmux pane via the existing `send_keys` WS message — no protocol bump.
 *
 * Backs the paperclip / paste / drop UI on `AgentTerminalPanel.svelte`.
 *
 * Owner-only (mirrors the GET /plan and POST /stop sibling routes).
 * CSRF: double-submit (maw_csrf cookie + x-csrf-token header) — see
 * src/lib/server/auth/csrf.ts.
 *
 * Deployment note: adapter-node's default `BODY_SIZE_LIMIT` is 524288
 * (512 KB) — bodies above that are truncated before reaching this
 * handler, surfacing as a `no_file` error instead of `size`. Set
 * `BODY_SIZE_LIMIT` ≥ MAW_IMAGE_MAX_BYTES (default 5 MiB → 6291456
 * is a comfortable round-up) in the prod / dev environment so the
 * intended 5 MB cap is the one users hit.
 *
 * The route does NOT gate on cli_kind. Whether the feature *makes
 * sense* for a given adapter is signalled by the per-adapter
 * `acceptsImageAttachment` flag (see AdapterRegistry.list()) which the
 * client uses to gate rendering. Server-side, an authenticated owner
 * can already write to their own worktree via git operations, so an
 * extra cli_kind gate would only create a moot test friction without
 * tightening any real boundary.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { getAgent, getWorktree } from '$lib/server/db/queries';
import {
  MAX_BYTES,
  validateUpload,
  writeAgentImage
} from '$lib/server/uploads/agentImageUploads';

export const POST: RequestHandler = async (event) => {
  const { locals, params, request } = event;
  verifyCsrf(event);
  if (!locals.user) throw error(401, 'Unauthorized');

  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const wt = getWorktree(agent.worktree_id);
  if (!wt) throw error(404, 'Worktree not found');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ code: 'no_file' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return json({ code: 'no_file' }, { status: 400 });
  }

  const v = validateUpload(file.type, file.size);
  if (!v.ok) {
    return json({ code: v.code, maxBytes: MAX_BYTES }, { status: 400 });
  }

  // Size already gated; safe to materialize.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const out = await writeAgentImage(wt.path, file.type, bytes);

  return json({
    relativePath: out.relativePath,
    filename: out.filename,
    sizeBytes: bytes.byteLength,
    mime: file.type
  });
};
