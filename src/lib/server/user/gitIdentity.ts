import { getUserById, getUserSetting, setUserSetting } from '$lib/server/db/queries';

export interface GitIdentity {
  name: string;
  email: string;
}

export const GIT_AUTHOR_NAME_KEY = 'git.authorName';
export const GIT_AUTHOR_EMAIL_KEY = 'git.authorEmail';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX = 100;
const EMAIL_MAX = 254;

function parseString(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Raw configured identity, or `null` fields if unset. Use `resolveGitIdentity`
 * when you need a ready-to-use identity with a sane fallback.
 */
export function getStoredGitIdentity(userId: string): { name: string | null; email: string | null } {
  return {
    name: parseString(getUserSetting(userId, GIT_AUTHOR_NAME_KEY)),
    email: parseString(getUserSetting(userId, GIT_AUTHOR_EMAIL_KEY))
  };
}

export function hasGitIdentity(userId: string): boolean {
  const { name, email } = getStoredGitIdentity(userId);
  return !!name && !!email;
}

/**
 * Resolve the git identity for the user, falling back to
 * `{ name: username, email: <username>@maw.local }` when either field is
 * unset — so commit/spawn paths always have *something* usable.
 */
export function resolveGitIdentity(userId: string, username: string): GitIdentity {
  const stored = getStoredGitIdentity(userId);
  return {
    name: stored.name ?? username,
    email: stored.email ?? `${username}@maw.local`
  };
}

/**
 * Convenience wrapper for callers that have `userId` but not `username`.
 * Throws if the user doesn't exist — this should never happen in practice
 * (all callers hold a valid session).
 */
export function resolveGitIdentityForUser(userId: string): GitIdentity {
  const user = getUserById(userId);
  if (!user) throw new Error(`user not found: ${userId}`);
  return resolveGitIdentity(userId, user.username);
}

export type ValidationError = 'nameRequired' | 'nameInvalid' | 'emailRequired' | 'emailInvalid';

export function validateGitIdentity(name: string, email: string): ValidationError | null {
  if (!name) return 'nameRequired';
  if (name.length > NAME_MAX || name.includes('<') || name.includes('>')) return 'nameInvalid';
  if (!email) return 'emailRequired';
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email) || email.includes('<') || email.includes('>'))
    return 'emailInvalid';
  return null;
}

/**
 * Persist an identity. Caller is responsible for calling `validateGitIdentity`
 * first and surfacing the failure — this function trusts its inputs.
 */
export function setGitIdentity(userId: string, identity: GitIdentity): void {
  setUserSetting(userId, GIT_AUTHOR_NAME_KEY, JSON.stringify(identity.name));
  setUserSetting(userId, GIT_AUTHOR_EMAIL_KEY, JSON.stringify(identity.email));
}
