import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the MAW e2e suite.
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
/** The bootstrap step seeds the user with email = `<username>@maw.local`,
 *  matching the migration `users.username` → `user.email` mapping. */
export const E2E_EMAIL = `${E2E_BOOTSTRAP_USERNAME}@maw.local`;
/** Final password after global-setup rotates the bootstrap one. */
export const E2E_PASSWORD = 'e2e-rotated-pw-!9x';
export const E2E_USERNAME = E2E_BOOTSTRAP_USERNAME;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  // The chromium gpu-process intermittently SEGVs on `ubuntu-latest` runners
  // mid-suite (`InitializeSandbox() called with multiple threads in process
  // gpu-process` → SIGSEGV in the GPU shim, which kills the whole browser).
  // The next test then errors with `browser.newContext: Target page, context
  // or browser has been closed` even though it's never the test's fault. One
  // CI retry covers the residual flake without masking real test bugs.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './tests/e2e/global-setup.ts',

  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    storageState: 'tests/e2e/auth.storage.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Stop chromium from spawning the GPU process at all on Linux runners.
    // We render no canvas/webgl in any test path, so software-rasterizer
    // off + gpu off removes both crash surfaces (GPU init + swiftshader
    // fallback) without changing how any page actually renders for the
    // tests' assertions.
    launchOptions: {
      args: ['--disable-gpu', '--disable-software-rasterizer']
    }
  },

  projects: [
    {
      name: 'smoke',
      testMatch:
        /(?:smoke|agent-lifecycle|agent-window-menu|agent-image-upload)\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] }
    },
    {
      // Terminal alignment regressions spawn real CLIs and let xterm reflow
      // against a real tmux pane, so they want a longer budget than the
      // hydration-smoke defaults and a viewport pinned to the size the cursor
      // math was written against. Bash always available; claude spec self-skips
      // when the adapter isn't registered.
      name: 'terminal',
      testMatch: /terminal-[^/]+\.spec\.ts$/,
      timeout: 60_000,
      expect: { timeout: 15_000 },
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 }
      }
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
      MAW_BOOTSTRAP_PASSWORD: E2E_BOOTSTRAP_PASSWORD,
      // Match the dev/preview/start scripts in package.json. Each live
      // AgentRuntime parks one libuv threadpool thread (FifoStreamer
      // header has the full why), and stale FIFO read threads can
      // linger past stop() — with the libuv default of 4 threads, the
      // 5th tmux/git/argon2 op on the threadpool starves and the
      // process appears to hang. node build/server.js (what the e2e
      // webServer runs) inherits the env's value, not the script's.
      UV_THREADPOOL_SIZE: '64',
      // adapter-node truncates request bodies above 512 KB by default
      // (BODY_SIZE_LIMIT=524288). The image-upload route's per-image
      // cap is 5 MB, so the e2e oversize test (5 MB + 1 byte) needs the
      // server to actually receive the full body before our route can
      // return a `size` code rather than the truncated body's `no_file`.
      BODY_SIZE_LIMIT: '6291456'
    }
  }
});

/** Exported so global-setup can use the same values. */
export const E2E_BOOTSTRAP = {
  username: E2E_BOOTSTRAP_USERNAME,
  password: E2E_BOOTSTRAP_PASSWORD
};
