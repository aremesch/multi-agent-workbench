import { test, expect } from './fixtures';

/**
 * Hydration smoke tests.
 *
 * These don't verify business logic — they verify that when you load a
 * real page in a real browser, the client-side Svelte runtime actually
 * takes over and click handlers work. Every navigation is also watched
 * for CSP violations via the `page` fixture in ./fixtures.ts; a single
 * `Refused to execute inline script` in the console fails the test.
 */

test.describe('dashboard hydration', () => {
  test('landing page hydrates without CSP violations', async ({ page }) => {
    await page.goto('/');
    // Wait for Svelte to claim the window. `__svelte` only appears after
    // kit.start() has run, which is exactly what a broken CSP blocks.
    await expect
      .poll(() => page.evaluate(() => Boolean((globalThis as any).__svelte)), {
        timeout: 5_000,
        message: 'window.__svelte never became truthy — hydration did not run'
      })
      .toBe(true);
  });

  test('user menu opens on click', async ({ page }) => {
    await page.goto('/');
    const userBtn = page.locator('button.user-btn');
    await expect(userBtn).toHaveAttribute('aria-expanded', 'false');
    await userBtn.click();
    await expect(userBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[role="menu"]')).toBeVisible();
  });

  test('spawn FAB opens agent dialog', async ({ page }) => {
    await page.goto('/');
    await page.locator('button.fab').click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    // We don't assert the i18n string of the title — it shifts with the
    // user's detected locale. Presence of an <h2> is enough to prove the
    // spawn form actually mounted inside the dialog.
    await expect(dialog.locator('h2')).toBeVisible();
  });
});
