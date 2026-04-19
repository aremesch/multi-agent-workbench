import type { Cookies } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow, UserRow } from '../db/types.js';

// -----------------------------------------------------------------------------
// Mocks — replace DB queries and the config singleton so session.ts is
// exercised in isolation. Each test calls `resetMocks()` to wipe state.
// -----------------------------------------------------------------------------

const sessions = new Map<string, SessionRow>();
const users = new Map<string, UserRow>();

vi.mock('../db/queries.js', () => ({
  insertSession: vi.fn((row: Omit<SessionRow, 'created_at' | 'updated_at'>) => {
    sessions.set(row.id, { ...row, created_at: 0, updated_at: 0 });
  }),
  getSessionById: vi.fn((id: string) => sessions.get(id)),
  deleteSession: vi.fn((id: string) => {
    sessions.delete(id);
  }),
  getUserById: vi.fn((id: string) => users.get(id))
}));

vi.mock('../config.js', () => ({
  getConfig: () => ({
    sessionTtlSeconds: 3600,
    isDev: false
  })
}));

import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  resolveSession,
  setSessionCookie
} from './session.js';

// -----------------------------------------------------------------------------
// Cookies fake — only the methods session.ts touches.
// -----------------------------------------------------------------------------

interface StoredCookie {
  value: string;
  opts: Parameters<Cookies['set']>[2];
}

function makeCookies(initial: Record<string, string> = {}): {
  cookies: Cookies;
  store: Map<string, StoredCookie>;
} {
  const store = new Map<string, StoredCookie>();
  for (const [k, v] of Object.entries(initial)) store.set(k, { value: v, opts: { path: '/' } });
  const cookies: Cookies = {
    get: (n) => store.get(n)?.value,
    getAll: () => [...store.entries()].map(([name, { value }]) => ({ name, value })),
    set: (n, v, o) => {
      store.set(n, { value: v, opts: o });
    },
    delete: (n) => {
      store.delete(n);
    },
    serialize: () => {
      throw new Error('serialize not used');
    }
  };
  return { cookies, store };
}

function makeUser(id: string): UserRow {
  return {
    id,
    username: `u-${id}`,
    password_hash: 'x',
    must_change_password: 0,
    password_updated_at: null,
    created_at: 0,
    updated_at: 0
  };
}

beforeEach(() => {
  sessions.clear();
  users.clear();
  vi.clearAllMocks();
});

describe('createSession', () => {
  it('returns a ULID-shaped session id with expiry = now + TTL', () => {
    const now = Math.floor(Date.now() / 1000);
    const row = createSession('user-1', 'Mozilla/5.0');
    expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // Crockford base32 ULID
    expect(row.user_id).toBe('user-1');
    expect(row.user_agent).toBe('Mozilla/5.0');
    // Allow ±2s clock slop
    expect(row.expires_at).toBeGreaterThanOrEqual(now + 3600 - 2);
    expect(row.expires_at).toBeLessThanOrEqual(now + 3600 + 2);
  });

  it('persists the row via insertSession', () => {
    const row = createSession('user-2', null);
    expect(sessions.get(row.id)).toMatchObject({
      id: row.id,
      user_id: 'user-2',
      user_agent: null
    });
  });

  it('generates a distinct id on every call', () => {
    const a = createSession('u', null);
    const b = createSession('u', null);
    expect(a.id).not.toBe(b.id);
  });
});

describe('resolveSession', () => {
  it('returns { user:null, session:null } when the cookie is absent', () => {
    const { cookies } = makeCookies();
    expect(resolveSession(cookies)).toEqual({ user: null, session: null });
  });

  it('returns { user:null, session:null } when the session id is unknown', () => {
    const { cookies } = makeCookies({ [SESSION_COOKIE]: 'ghost-id' });
    expect(resolveSession(cookies)).toEqual({ user: null, session: null });
  });

  it('resolves a fresh session to its user', () => {
    users.set('user-3', makeUser('user-3'));
    const row = createSession('user-3', 'ua');
    const { cookies } = makeCookies({ [SESSION_COOKIE]: row.id });
    const out = resolveSession(cookies);
    expect(out.user?.id).toBe('user-3');
    expect(out.session?.id).toBe(row.id);
  });

  it('deletes the session and returns null when expired', async () => {
    users.set('user-4', makeUser('user-4'));
    const row = createSession('user-4', null);
    // Forcibly backdate the expiry.
    sessions.set(row.id, { ...row, expires_at: Math.floor(Date.now() / 1000) - 1 });
    const { cookies } = makeCookies({ [SESSION_COOKIE]: row.id });
    const out = resolveSession(cookies);
    expect(out).toEqual({ user: null, session: null });
    const { deleteSession } = await import('../db/queries.js');
    expect(deleteSession).toHaveBeenCalledWith(row.id);
  });

  it('returns null when the session points at a deleted user', () => {
    const row = createSession('ghost-user', null);
    // users map never populated.
    const { cookies } = makeCookies({ [SESSION_COOKIE]: row.id });
    expect(resolveSession(cookies)).toEqual({ user: null, session: null });
  });
});

describe('setSessionCookie / clearSessionCookie', () => {
  it('set → delete round-trip clears the cookie', () => {
    const { cookies, store } = makeCookies();
    setSessionCookie(cookies, 'session-id-aaa');
    expect(store.get(SESSION_COOKIE)?.value).toBe('session-id-aaa');
    clearSessionCookie(cookies);
    expect(store.has(SESSION_COOKIE)).toBe(false);
  });

  it('sets the cookie with hardening options (httpOnly, strict, path /, maxAge TTL)', () => {
    const { cookies, store } = makeCookies();
    setSessionCookie(cookies, 'x');
    const opts = store.get(SESSION_COOKIE)?.opts;
    expect(opts?.path).toBe('/');
    expect(opts?.httpOnly).toBe(true);
    expect(opts?.sameSite).toBe('strict');
    expect(opts?.maxAge).toBe(3600); // from mocked sessionTtlSeconds
    expect(opts?.secure).toBe(true); // !isDev
  });

  it('clears the cookie with the same path the setter used', () => {
    const { cookies, store } = makeCookies({ [SESSION_COOKIE]: 'x' });
    clearSessionCookie(cookies);
    expect(store.has(SESSION_COOKIE)).toBe(false);
  });
});
