import { test as base, expect } from '@playwright/test';

/**
 * Playwright test fixture that fails a test if the browser reports any
 * CSP violations or uncaught page errors during its run.
 *
 * This is the entire reason the e2e suite exists. The original motivating
 * bug (commit 273f95b, docs/plans/v0.2-playwright-hydration-smoke-tests.md)
 * was a CSP header that blocked SvelteKit's inline hydration bootstrap —
 * the page rendered fine via SSR but every onclick silently failed. The
 * browser logs `Refused to execute inline script...` in that case; that
 * single console message is what this fixture catches.
 *
 * Attaches listeners BEFORE `await use(page)` so violations fired during
 * the initial navigation (not just subsequent actions) are captured too.
 */

const CSP_PATTERN = /content security policy|refused to execute|refused to apply/i;

export const test = base.extend({
  page: async ({ page }, use) => {
    const violations: string[] = [];

    page.on('pageerror', (err) => {
      violations.push(`pageerror: ${err.message}`);
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (CSP_PATTERN.test(text)) {
        violations.push(`csp: ${text}`);
      }
    });

    await use(page);

    expect(
      violations,
      `browser reported ${violations.length} CSP/page errors during the test:\n${violations.join('\n')}`
    ).toHaveLength(0);
  }
});

export { expect };
