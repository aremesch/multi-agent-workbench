import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api.js';

function clearAllCookies(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.trim().split('=')[0];
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
}

describe('apiFetch', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    clearAllCookies();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAllCookies();
  });

  it('passes GET through without a CSRF header', async () => {
    document.cookie = 'maw_csrf=abc';
    await apiFetch('/api/x');
    expect(fetchSpy).toHaveBeenCalledWith('/api/x', {});
  });

  it('passes HEAD through without a CSRF header', async () => {
    document.cookie = 'maw_csrf=abc';
    await apiFetch('/api/x', { method: 'HEAD' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.headers).toBeUndefined();
  });

  it('passes OPTIONS through without a CSRF header', async () => {
    document.cookie = 'maw_csrf=abc';
    await apiFetch('/api/x', { method: 'OPTIONS' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.headers).toBeUndefined();
  });

  it('attaches x-csrf-token to POST when cookie present', async () => {
    document.cookie = 'maw_csrf=token-123';
    await apiFetch('/api/x', { method: 'POST' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    const headers = init?.headers as Headers;
    expect(headers.get('x-csrf-token')).toBe('token-123');
  });

  it('attaches x-csrf-token to PUT/DELETE/PATCH', async () => {
    document.cookie = 'maw_csrf=abc';
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      fetchSpy.mockClear();
      await apiFetch('/api/x', { method });
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
      expect((init?.headers as Headers).get('x-csrf-token')).toBe('abc');
    }
  });

  it('URL-decodes the cookie value', async () => {
    document.cookie = 'maw_csrf=' + encodeURIComponent('a+b/c=d');
    await apiFetch('/api/x', { method: 'POST' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect((init?.headers as Headers).get('x-csrf-token')).toBe('a+b/c=d');
  });

  it('does not overwrite an explicit x-csrf-token header', async () => {
    document.cookie = 'maw_csrf=auto';
    await apiFetch('/api/x', {
      method: 'POST',
      headers: { 'x-csrf-token': 'explicit' }
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect((init?.headers as Headers).get('x-csrf-token')).toBe('explicit');
  });

  it('omits the header when no cookie is set', async () => {
    await apiFetch('/api/x', { method: 'POST' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect((init?.headers as Headers).has('x-csrf-token')).toBe(false);
  });

  it('uppercases the method for safe-method detection', async () => {
    document.cookie = 'maw_csrf=abc';
    await apiFetch('/api/x', { method: 'get' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    // Safe-method branch passes init through unmodified.
    expect(init).toEqual({ method: 'get' });
  });

  it('defaults method to GET when init.method is absent', async () => {
    document.cookie = 'maw_csrf=abc';
    await apiFetch('/api/x', { body: 'ignored' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    // Safe-method branch — init is passed through as-is, no headers added.
    expect(init).toEqual({ body: 'ignored' });
  });
});
