/**
 * Authentication event logger.
 *
 * Writes one line per event to `${MAW_DATA_DIR}/auth.log` (the source fed to
 * fail2ban) AND inserts a row in `auth_events` (in-app audit). Both paths are
 * wrapped so logging never throws — a failure to log must not break login or
 * logout.
 *
 * Line format is stable; fail2ban filters in `deploy/fail2ban/filter.d/`
 * match it verbatim. Changing it is a breaking change for the jail config.
 *   <iso8601> <event> user=<u> ip=<ip> ua="<ua>"
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../config.js';
import { insertAuthEvent } from '../db/queries.js';

export type AuthEvent =
  | 'login_ok'
  | 'login_fail'
  | 'pwchange_ok'
  | 'pwchange_fail'
  | 'session_revoked'
  | 'rate_limited'
  | 'ws_origin_reject';

const SAFE = /[\r\n\t]/g;
const clean = (s: string | null | undefined): string =>
  (s ?? '-').replace(SAFE, ' ').slice(0, 256);

let ensuredDir = false;
function ensureLogDir(path: string): void {
  if (ensuredDir) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    ensuredDir = true;
  } catch {
    /* best-effort */
  }
}

export function logAuth(
  event: AuthEvent,
  fields: {
    userId?: string | null;
    username?: string | null;
    ip: string;
    userAgent?: string | null;
    detail?: string | null;
  }
): void {
  const ts = Math.floor(Date.now() / 1000);
  const line =
    `${new Date(ts * 1000).toISOString()} ${event}` +
    ` user=${clean(fields.username)}` +
    ` ip=${clean(fields.ip)}` +
    ` ua="${clean(fields.userAgent)}"\n`;

  try {
    const path = getConfig().authLogPath;
    ensureLogDir(path);
    appendFileSync(path, line);
  } catch {
    /* never throw from logger */
  }
  try {
    insertAuthEvent({
      ts,
      event,
      user_id: fields.userId ?? null,
      username: fields.username ?? null,
      ip: fields.ip,
      user_agent: fields.userAgent ?? null,
      detail: fields.detail ?? null
    });
  } catch {
    /* never throw from logger */
  }
}
