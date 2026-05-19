/**
 * POST /api/queue/:id/attachments  — stage one image (multipart `file`)
 * GET  /api/queue/:id/attachments  — list current attachment metadata
 *
 * Mirrors POST /api/agents/:id/upload-image (CSRF double-submit, owner-
 * only) but writes to the per-task staging dir instead of a worktree —
 * a queued task has no worktree until the scheduler promotes it. The
 * staged files are copied into the agent's worktree and referenced in
 * the prompt at promote time (see taskAttachmentUploads.materialize…).
 *
 * Refuses tasks that are no longer editable (running/terminal) — you
 * can't change the inputs of an in-flight or finished task. The staging
 * path is server-private and never returned to the client.
 *
 * Deployment note: as with upload-image, set adapter-node's
 * `BODY_SIZE_LIMIT` ≥ MAW_IMAGE_MAX_BYTES (default 5 MiB) so oversize
 * bodies surface as `size`, not a truncated `no_file`.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { getQueueEntryForUser, setQueueEntryAttachments } from '$lib/server/db/queries';
import { MAX_BYTES, validateUpload } from '$lib/server/uploads/imageUploadCore';
import {
  MAX_TASK_ATTACHMENTS,
  parseAttachments,
  publicAttachments,
  serializeAttachments,
  stageTaskAttachment
} from '$lib/server/uploads/taskAttachmentUploads';

/** running/done/failed/cancelled → inputs are frozen (mirrors PUT edit). */
const FROZEN = new Set(['running', 'done', 'failed', 'cancelled']);

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const entry = getQueueEntryForUser(params.id, locals.user.id);
  if (!entry) throw error(404, 'Task not found');
  return json({
    attachments: publicAttachments(parseAttachments(entry.attachments_json))
  });
};

export const POST: RequestHandler = async (event) => {
  const { locals, params, request } = event;
  verifyCsrf(event);
  if (!locals.user) throw error(401, 'Unauthorized');

  const entry = getQueueEntryForUser(params.id, locals.user.id);
  if (!entry) throw error(404, 'Task not found');
  if (FROZEN.has(entry.status)) {
    return json({ code: 'frozen' }, { status: 409 });
  }

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

  const existing = parseAttachments(entry.attachments_json);
  if (existing.length >= MAX_TASK_ATTACHMENTS) {
    return json(
      { code: 'too_many', max: MAX_TASK_ATTACHMENTS },
      { status: 400 }
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const rec = await stageTaskAttachment(params.id, file.type, bytes);
  const ok = setQueueEntryAttachments(
    params.id,
    locals.user.id,
    serializeAttachments([...existing, rec])
  );
  if (!ok) {
    // Row vanished between the load and the write (cancel/delete race).
    return json({ code: 'frozen' }, { status: 409 });
  }

  return json({ filename: rec.filename, sizeBytes: rec.size, mime: rec.mime });
};
