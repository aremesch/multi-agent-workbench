import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for hydration smoke tests.
 *
 * Runs against the bundled production server (`node build/server.js`) — not
 * `vite dev` — because the CSP/hydration class of regression we care about
 * (commit 273f95b, see docs/plans/v0.2-playwright-hydration-smoke-tests.md)
 * only manifests against the real compiled bootstrap script the prod
 * adapter emits.
 *
 * Fresh temp data dir per run forces the bootstrap user creation path to
 * be exercised every time. The global-setup step logs in with the seeded
 * credentials and immediately clears `must_change_password` via the
 * /account change-password action, then saves the resulting cookies as
 * storageState so individual tests start authenticated.
 */

const E2E_PORT = 4173;
const E2E_DATA_DIR = '/tmp/maw-e2e';
const E2E_BOOTSTRAP_USERNAME = 'e2e';
const E2E_BOOTSTRAP_PASSWORD = 'e2e-seed-pw-!9x';
/** Final password after global-setup rotates the bootstrap one. */
export const E2E_PASSWORD = 'e2e-rotated-pw-!9x';
export const E2E_USERNAME = E2E_BOOTSTRAP_USERNAME;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './tests/e2e/global-setup.ts',

  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    storageState: 'tests/e2e/auth.storage.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],

  webServer: {
    // Wipe any leftover data dir from a previous run so bootstrap runs
    // cleanly every time. Playwright starts the webServer BEFORE
    // globalSetup, so a per-test cleanup hook can't do this.
    command: `rm -rf ${E2E_DATA_DIR} && pnpm build && node build/server.js`,
    url: `http://127.0.0.1:${E2E_PORT}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(E2E_PORT),
      HOST: '127.0.0.1',
      // adapter-node's CSRF origin check reads ORIGIN (falls back to
      // HOST_HEADER/PROTOCOL_HEADER). Without it, SvelteKit compares the
      // Origin header to an inferred URL origin that mismatches and the
      // browser sees "Cross-site POST form submissions are forbidden".
      ORIGIN: `http://127.0.0.1:${E2E_PORT}`,
      // Deliberately NOT `NODE_ENV=production`. The session cookie flag
      // `secure: !cfg.isDev` (src/lib/server/auth/session.ts:54) would
      // force Set-Cookie onto HTTPS only, and our test server is HTTP —
      // the browser would drop the cookie and every login would appear
      // to fail. The production bundle itself is already the same
      // artifact either way (vite build produces one bundle, NODE_ENV
      // at runtime only toggles this cookie flag + a boot log line).
      MAW_DATA_DIR: E2E_DATA_DIR,
      MAW_WORKTREE_ROOT: `${E2E_DATA_DIR}/worktrees`,
      MAW_FIFO_DIR: `${E2E_DATA_DIR}/fifos`,
      MAW_AUTH_LOG_PATH: `${E2E_DATA_DIR}/auth.log`,
      MAW_SESSION_SECRET: 'e2e-secret-not-for-prod',
      MAW_BOOTSTRAP_USERNAME: E2E_BOOTSTRAP_USERNAME,
      MAW_BOOTSTRAP_PASSWORD: E2E_BOOTSTRAP_PASSWORD
    }
  }
});

/** Exported so global-setup can use the same values. */
export const E2E_BOOTSTRAP = {
  username: E2E_BOOTSTRAP_USERNAME,
  password: E2E_BOOTSTRAP_PASSWORD
};
