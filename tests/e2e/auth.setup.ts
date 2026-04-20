import { expect, test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STORAGE = 'tests/e2e/.auth/user.json';

setup('authenticate', async ({ page }) => {
  const username = process.env.MAW_E2E_USERNAME;
  const password = process.env.MAW_E2E_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'MAW_E2E_USERNAME / MAW_E2E_PASSWORD must be set in the shell before running Playwright.'
    );
  }

  // Hit the login action directly via the request context. The in-browser
  // form submit flakes here (Chromium occasionally skips the POST on headless
  // SwiftShader), and going through `page.request` is both faster and exactly
  // equivalent cookie-wise — the maw_session cookie lands in the context's
  // jar and gets persisted by `storageState`. `origin` is required because
  // SvelteKit's built-in CSRF guard compares it to the request URL.
  const baseURL = process.env.MAW_E2E_URL ?? 'http://127.0.0.1:3457';
  const originURL = new URL(baseURL);
  const origin = `${originURL.protocol}//${originURL.host}`;

  // Seed the maw_csrf cookie (some JSON endpoints require it later).
  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  const res = await page.request.post('/login?/login', {
    form: { username, password },
    headers: { origin },
    maxRedirects: 0,
    failOnStatusCode: false
  });
  expect(res.status(), `login POST status (body: ${await res.text().catch(() => '<no body>')})`).toBeLessThan(400);

  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === 'maw_session'), 'maw_session cookie set').toBeTruthy();

  mkdirSync(dirname(STORAGE), { recursive: true });
  await page.context().storageState({ path: STORAGE });
});
