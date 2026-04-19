/**
 * GET/PUT /api/user/dashboard-layout
 *
 * Persists the gridstack positions of agent cards on the dashboard.
 * Stored in `user_settings` under key `dashboard.layout.v1` as
 *   { layout: [{ agentId, x, y, w, h }, ...] }
 *
 * The frontend debounces writes, so PUTs land every ~500ms at most while
 * dragging.
 */

import { error, json } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { getUserSetting, setUserSetting } from '$lib/server/db/queries';
import { DASHBOARD_LAYOUT_KEY, isValidLayoutKey } from '$lib/shared/dashboard';

const layoutSchema = z.object({
  key: z.string().min(1).optional(),
  layout: z.array(
    z.object({
      agentId: z.string().min(1),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      w: z.number().int().min(1),
      h: z.number().int().min(1)
    })
  )
});

type DashboardLayout = z.infer<typeof layoutSchema>;

function resolveKey(raw: string | null | undefined): string | null {
  const key = raw ?? DASHBOARD_LAYOUT_KEY;
  return isValidLayoutKey(key) ? key : null;
}

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const key = resolveKey(url.searchParams.get('key'));
  if (!key) throw error(400, 'Invalid key');
  const raw = getUserSetting(locals.user.id, key);
  if (!raw) return json({ layout: null });
  try {
    const parsed = layoutSchema.parse(JSON.parse(raw));
    return json({ layout: parsed.layout });
  } catch {
    // Corrupt row — nuke and behave as if no layout exists.
    return json({ layout: null });
  }
};

export const PUT: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const result = layoutSchema.safeParse(body);
  if (!result.success) {
    throw error(400, 'Invalid layout shape');
  }
  const key = resolveKey(result.data.key);
  if (!key) throw error(400, 'Invalid key');
  setUserSetting(
    locals.user.id,
    key,
    JSON.stringify({ layout: result.data.layout })
  );
  return new Response(null, { status: 204 });
};
