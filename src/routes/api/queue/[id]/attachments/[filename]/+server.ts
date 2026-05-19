/**
 * DELETE /api/queue/:id/attachments/:filename
 *
 * Remove one staged attachment from an editable task. CSRF + owner-only.
 * `filename` is charset-guarded inside deleteStagedAttachment; an unknown
 * filename (not in the task's list) is a 404.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { getQueueEntryForUser, setQueueEntryAttachments } from '$lib/server/db/queries';
import {
  deleteStagedAttachment,
  parseAttachments,
  serializeAttachments
} from '$lib/server/uploads/taskAttachmentUploads';

const FROZEN = new Set(['running', 'done', 'failed', 'cancelled']);

export const DELETE: RequestHandler = async (event) => {
  const { locals, params } = event;
  verifyCsrf(event);
  if (!locals.user) throw error(401, 'Unauthorized');

  const entry = getQueueEntryForUser(params.id, locals.user.id);
  if (!entry) throw error(404, 'Task not found');
  if (FROZEN.has(entry.status)) {
    return json({ code: 'frozen' }, { status: 409 });
  }

  const list = parseAttachments(entry.attachments_json);
  const target = list.find((r) => r.filename === params.filename);
  if (!target) throw error(404, 'Attachment not found');

  try {
    await deleteStagedAttachment(params.id, params.filename);
  } catch {
    return json({ code: 'invalid_filename' }, { status: 400 });
  }

  setQueueEntryAttachments(
    params.id,
    locals.user.id,
    serializeAttachments(list.filter((r) => r.filename !== params.filename))
  );
  return json({ ok: true });
};
