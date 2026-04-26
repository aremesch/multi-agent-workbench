import { test, expect } from '@playwright/test';

// Asserts the wire HTTP status returned by the login form action matches
// the action's fail() argument for both content-negotiation paths.
//
// Without the honestActionStatus hook in src/hooks.server.ts, SvelteKit's
// JSON-action path (taken whenever Accept negotiates to application/json,
// including curl's default Accept of */* with the kit listing JSON first)
// packs fail()'s status into the response BODY but pins the wire at 200 —
// masking failed-login attacks from HTTP-status-based monitoring and WAF
// rules. Browsers always took the HTML render path, so this regression
// class only ever surfaces against non-browser clients.

test.use({ storageState: { cookies: [], origins: [] } });

// SvelteKit's csrf.checkOrigin (default ON) requires the Origin header
// to match the URL origin on form-style POSTs; Playwright's request API
// doesn't auto-populate Origin like a browser does, so set it explicitly.
const ORIGIN = 'http://127.0.0.1:4173';

test.describe('login wire status', () => {
  test('JSON path returns 401 on bad credentials', async ({ request }) => {
    const r = await request.post('/login?/login', {
      form: { username: 'nobody', password: 'wrong' },
      headers: { Accept: 'application/json', Origin: ORIGIN }
    });
    expect(r.status()).toBe(401);
  });

  test('HTML path returns 401 on bad credentials', async ({ request }) => {
    const r = await request.post('/login?/login', {
      form: { username: 'nobody', password: 'wrong' },
      headers: { Accept: 'text/html', Origin: ORIGIN }
    });
    expect(r.status()).toBe(401);
  });
});
