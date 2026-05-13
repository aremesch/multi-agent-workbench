/**
 * Thin wrapper around `git clone <url> <path>`.
 *
 * Used by `POST /api/repos` when the caller passes `clone_url` and
 * the target directory is either empty or freshly created: we populate
 * it via clone instead of the default `git init`.
 *
 * Authentication: we rely on the MAW server user's SSH agent /
 * `~/.ssh/id_*` for ssh:// and `git@host:...` URLs. HTTPS URLs will
 * use whatever git-credential helper is configured on the host (or
 * succeed only for public repos). We do not prompt — `GIT_TERMINAL_PROMPT=0`
 * is forced so a missing credential fails cleanly instead of hanging.
 */

import { getGit } from './client.js';

export type CloneErrorCode = 'invalid_url' | 'auth_failed' | 'clone_failed';

export class CloneError extends Error {
  constructor(public code: CloneErrorCode, message: string) {
    super(message);
    this.name = 'CloneError';
  }
}

/**
 * Validate the URL shape. Accepts:
 *   - https://host/org/repo(.git)?
 *   - http://host/org/repo(.git)?   (rare, mostly self-hosted)
 *   - ssh://user@host/path
 *   - user@host:path  (scp-style)
 *   - git://host/path
 */
const SCP_STYLE_RE = /^[A-Za-z0-9._~-]+@[A-Za-z0-9.-]+:[^\s]+$/;

export function isAcceptableCloneUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url) return false;
  if (SCP_STYLE_RE.test(url)) return true;
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' ||
      u.protocol === 'http:' ||
      u.protocol === 'ssh:' ||
      u.protocol === 'git:'
    );
  } catch {
    return false;
  }
}

export interface CloneOptions {
  /** Hard timeout in ms. Defaults to 2 minutes. */
  timeoutMs?: number;
}

/**
 * Run `git clone <url> <path>` with prompt-less credentials.
 *
 * Throws CloneError('invalid_url') before shelling out for malformed URLs,
 * CloneError('auth_failed') when git's stderr mentions an auth failure,
 * and CloneError('clone_failed') for everything else.
 */
export async function cloneInto(
  url: string,
  path: string,
  opts: CloneOptions = {}
): Promise<void> {
  if (!isAcceptableCloneUrl(url)) {
    throw new CloneError('invalid_url', 'Unsupported clone URL');
  }
  const timeout = opts.timeoutMs ?? 120_000;

  const git = getGit(undefined, {
    timeout: { block: timeout }
  });

  try {
    await git.env({
      ...process.env,
      // Fail-fast when HTTPS needs a credential we don't have — don't
      // hang on an interactive prompt.
      GIT_TERMINAL_PROMPT: '0',
      // Likewise: no ssh password prompt.
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'
    }).clone(url, path, ['--']);
  } catch (err) {
    const e = err as { message: string };
    const blob = e.message.toLowerCase();
    if (
      blob.includes('permission denied') ||
      blob.includes('authentication failed') ||
      blob.includes('could not read username') ||
      blob.includes('host key verification failed')
    ) {
      throw new CloneError('auth_failed', e.message.trim());
    }
    throw new CloneError('clone_failed', e.message.trim());
  }
}
