import type { Cookies } from '@sveltejs/kit';
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE, CSRF_HEADER, ensureCsrfCookie, verifyCsrf } from './csrf.js';

// -----------------------------------------------------------------------------
// Minimal Cookies fake matching the SvelteKit Cookies contract. Only the
// methods used by csrf.ts are real; everything else throws so drift is loud.
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
    get: (name) => store.get(name)?.value,
    getAll: () =>
      [...store.entries()].map(([name, { value }]) => ({ name, value })),
    set: (name, value, opts) => {
      store.set(name, { value, opts });
    },
    delete: (name, opts) => {
      store.delete(name);
      void opts;
    },
    serialize: () => {
      throw new Error('serialize not used by csrf.ts');
    }
  };
  return { cookies, store };
}

function makeRequest(headers: Record<string, string>): Request {
  return new Request('http://localhost/x', { method: 'POST', headers });
}

describe('ensureCsrfCookie', () => {
  it('issues a new token when none is set', () => {
    const { cookies, store } = makeCookies();
    const token = ensureCsrfCookie(cookies);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(store.get(CSRF_COOKIE)?.value).toBe(token);
  });

  it('returns the existing token on subsequent calls (idempotent)', () => {
    const { cookies } = makeCookies({ [CSRF_COOKIE]: 'pre-existing-token' });
    expect(ensureCsrfCookie(cookies)).toBe('pre-existing-token');
  });

  it('sets the cookie with the expected hardening options', () => {
    const { cookies, store } = makeCookies();
    ensureCsrfCookie(cookies);
    const opts = store.get(CSRF_COOKIE)?.opts;
    expect(opts?.path).toBe('/');
    expect(opts?.httpOnly).toBe(false); // client JS reads it for echo-back
    expect(opts?.sameSite).toBe('strict');
    expect(opts?.maxAge).toBe(60 * 60 * 24 * 365);
  });

  it('emits distinct tokens across independent cookie jars', () => {
    const a = ensureCsrfCookie(makeCookies().cookies);
    const b = ensureCsrfCookie(makeCookies().cookies);
    expect(a).not.toBe(b);
  });
});

describe('verifyCsrf', () => {
  function event(cookies: Cookies, headers: Record<string, string>): Parameters<typeof verifyCsrf>[0] {
    return { cookies, request: makeRequest(headers) };
  }

  it('passes when cookie and header match byte-for-byte', () => {
    const token = 'abc123token';
    const { cookies } = makeCookies({ [CSRF_COOKIE]: token });
    expect(() => verifyCsrf(event(cookies, { [CSRF_HEADER]: token }))).not.toThrow();
  });

  it('throws a SvelteKit 403 on mismatched token', () => {
    const { cookies } = makeCookies({ [CSRF_COOKIE]: 'aaa' });
    let thrown: unknown;
    try {
      verifyCsrf(event(cookies, { [CSRF_HEADER]: 'bbb' }));
    } catch (e) {
      thrown = e;
    }
    expect(isHttpError(thrown)).toBe(true);
    expect((thrown as { status: number }).status).toBe(403);
    expect((thrown as { body: { message: string } }).body.message).toBe('csrf');
  });

  it('throws 403 when the cookie is missing', () => {
    const { cookies } = makeCookies();
    expect(() => verifyCsrf(event(cookies, { [CSRF_HEADER]: 'x' }))).toThrow();
  });

  it('throws 403 when the header is missing', () => {
    const { cookies } = makeCookies({ [CSRF_COOKIE]: 'x' });
    expect(() => verifyCsrf(event(cookies, {}))).toThrow();
  });

  it('throws 403 on differing lengths without invoking timingSafeEqual (which would throw)', () => {
    // timingSafeEqual throws on unequal-length buffers; csrf.ts guards with
    // a length check first so the 403 path stays clean.
    const { cookies } = makeCookies({ [CSRF_COOKIE]: 'short' });
    expect(() => verifyCsrf(event(cookies, { [CSRF_HEADER]: 'much-longer-token' }))).toThrow();
  });

  it('uses timing-safe comparison (equal-length, same-byte → pass)', () => {
    const token = 'a'.repeat(32);
    const { cookies } = makeCookies({ [CSRF_COOKIE]: token });
    expect(() => verifyCsrf(event(cookies, { [CSRF_HEADER]: token }))).not.toThrow();
  });

  it('rejects equal-length but byte-differing tokens', () => {
    const { cookies } = makeCookies({ [CSRF_COOKIE]: 'a'.repeat(32) });
    expect(() =>
      verifyCsrf(event(cookies, { [CSRF_HEADER]: 'b'.repeat(32) }))
    ).toThrow();
  });
});
