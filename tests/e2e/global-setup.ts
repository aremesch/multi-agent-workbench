import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_BOOTSTRAP, E2E_PASSWORD } from '../../playwright.config';

/**
 * One-time setup for the Playwright hydration smoke suite.
 *
 * Playwright's webServer config has already booted the bundled server with
 * `MAW_BOOTSTRAP_USERNAME` / `MAW_BOOTSTRAP_PASSWORD` and a fresh temp
 * data dir. The seeded user lands with `must_change_password = 1`, so the
 * hooks gate (src/hooks.server.ts:32-44) redirects every path except
 * /account back to /account. We drive a real browser through:
 *
 *   1. POST /login?/login                  (bootstrap creds)
 *   2. POST /account?/changePassword       (rotate to E2E_PASSWORD)
 *
 * Saving the resulting cookies as `storageState` lets each test start
 * fully authenticated with the gate cleared. We also wipe the `/tmp/maw-e2e`
 * data dir from any previous run BEFORE the server starts — Playwright
 * runs globalSetup after the webServer is up, so we can't clean here; the
 * cleanup ran in-process at config load time instead.
 *
 * Not using storageState would force every test to re-login through the
 * form, tripling wall-clock and adding flakiness for no coverage gain.
 */

const STORAGE_PATH = resolve(process.cwd(), 'tests/e2e/auth.storage.json');

export default async function globalSetup(config: FullConfig): Promise<void> {
  // Purge any stale auth from a previous run; the test data dir itself is
  // already fresh because the webServer points at a temp path we nuked in
  // the top-level config import (see the cleanup block below).
  if (existsSync(STORAGE_PATH)) rmSync(STORAGE_PATH);

  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) throw new Error('global-setup: baseURL missing from project config');

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    // 1. Sign in with the bootstrap creds.
    await page.goto('/login');
    await page.fill('input[name="username"]', E2E_BOOTSTRAP.username);
    await page.fill('input[name="password"]', E2E_BOOTSTRAP.password);
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL('**/account', { timeout: 10_000 });
    } catch (err) {
      const body = await page.content();
      const errText = await page.locator('.err').textContent().catch(() => null);
      throw new Error(
        `global-setup: login did not redirect to /account (url=${page.url()}, err=${errText ?? 'none'})\n` +
          `BODY SNIPPET:\n${body.slice(0, 2000)}`
      );
    }

    // 2. Rotate the password — this clears must_change_password.
    await page.fill('input[name="current"]', E2E_BOOTSTRAP.password);
    await page.fill('input[name="next"]', E2E_PASSWORD);
    await page.fill('input[name="confirm"]', E2E_PASSWORD);
    await page.click('button[type="submit"]');
    // SvelteKit returns { success: true } without a redirect; wait for the
    // confirmation message to appear instead.
    await page.waitForSelector('.ok', { timeout: 5_000 });

    // 3. Confirm the gate is cleared by loading the dashboard without a
    //    redirect to /account.
    await page.goto('/');
    await page.waitForURL('**/');
    const url = page.url();
    if (url.includes('/account')) {
      throw new Error(`global-setup: still redirected to /account after pw change (url=${url})`);
    }

    mkdirSync(resolve(STORAGE_PATH, '..'), { recursive: true });
    await context.storageState({ path: STORAGE_PATH });
  } finally {
    await browser.close();
  }
}
