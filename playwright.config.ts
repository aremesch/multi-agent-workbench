import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.MAW_E2E_URL ?? 'http://emaw:3000';

/**
 * Playwright config for terminal alignment regressions.
 *
 * Auth: a tiny `setup` project logs in once and persists the `maw_session`
 * cookie as `storageState` at `tests/e2e/.auth/user.json`. The real specs
 * depend on it and reuse the cookie, so they never hit `/login` themselves.
 *
 * Expects a MAW instance running at `MAW_E2E_URL` (defaults to the
 * developer's local `emaw` host). Credentials come from
 * `MAW_E2E_USERNAME` / `MAW_E2E_PASSWORD`; never commit them.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Terminal math is dimension-sensitive; pin the viewport.
    viewport: { width: 1280, height: 800 }
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        storageState: 'tests/e2e/.auth/user.json'
      },
      dependencies: ['setup']
    }
  ]
});
