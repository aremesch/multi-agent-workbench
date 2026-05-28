import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { test, expect } from './fixtures';

/**
 * Generic regression net for the "Show Log" modal — any cause that breaks
 * the user-visible "open archive → click View logs → see captured output"
 * flow fails this test. Catches:
 *
 *  - JS strict-mode `ReferenceError`s thrown by xterm.js or its bundle
 *    (the `void 0||(i={})` minify bug from
 *    docs/plans/v0.2-fix-xterm-minify-undeclared-i.md is the motivating
 *    case — but the spec doesn't know or care that's the cause).
 *  - CSP violations that block xterm's dynamic import.
 *  - 5xx / non-bytes responses from `/api/agents/[id]/log`.
 *  - The `ArchivedAgentLogModal` race regressions (xterm fits to 0×0,
 *    bytes flushed into a tiny grid → blank pane).
 *  - xterm parser throws on a specific byte sequence.
 *  - Future renderer regressions where the modal opens but stays blank.
 *
 * Strategy: seed a phantom archived agent directly via better-sqlite3
 * with a curated `terminal_log` payload that exercises the byte sequences
 * known to be tricky (DECRQM, alt-screen toggles, OSC, mouse modes, large
 * write, multi-byte UTF-8, intentionally-truncated CSI). Then drive a
 * real browser through the archive page → View logs flow and assert
 * three things:
 *
 *   1. No `pageerror` / CSP violation fires (via the existing fixture).
 *   2. The xterm.js DOM renderer paints rows.
 *   3. A literal sentinel ("MAW-LOG-SENTINEL-DONE") at the tail of the
 *      payload renders — proves bytes flowed end-to-end through xterm
 *      without a parser crash mid-stream.
 *
 * The test is intentionally agnostic about *why* a failure happens — the
 * value is in the contract assertion, not the cause diagnosis.
 */

const REPO_HOST_PATH = '/tmp/maw-e2e/log-display-test-repo';
const MAW_DB_PATH = '/tmp/maw-e2e/maw.db';
const TMUX_SESSION_PREFIX = 'phantom-log-display';

/**
 * Curated bytes that exercise the parser paths known to crash xterm in
 * minified bundles. Concatenated into one big chunk. The trailing sentinel
 * lets us assert end-to-end byte flow — if xterm throws partway through,
 * the sentinel never paints.
 *
 * Each block has a short comment naming the parser path it tickles, so a
 * future maintainer can extend with new cases without re-deriving the
 * intent.
 */
const TRICKY_PAYLOAD: Buffer = Buffer.concat([
  // DECRQM (Request DEC Private Mode) — `CSI ? Pm $ p`. Routes through
  // InputHandler.requestMode, the function that the es2020 + minify bug
  // turned into a ReferenceError trap.
  Buffer.from('\x1b[?1$p', 'binary'),
  Buffer.from('\x1b[?25$p', 'binary'),

  // DECSET / DECRST — alternate-screen toggle. Fires the buffer-switch
  // path inside InputHandler that other minifier interactions have
  // tripped over.
  Buffer.from('\x1b[?1049h', 'binary'),
  Buffer.from('alt-screen content\r\n', 'utf8'),
  Buffer.from('\x1b[?1049l', 'binary'),

  // SGR mouse mode + bracketed paste — `?1006h` and `?2004h` exercise
  // the mode-set table path.
  Buffer.from('\x1b[?1006h', 'binary'),
  Buffer.from('\x1b[?2004h', 'binary'),

  // OSC title set + ST. OSC handler is a frequent crash site under
  // partial inputs.
  Buffer.from('\x1b]0;Test Title\x07', 'binary'),

  // Truecolor + reset. Exercises the SGR parser's 24-bit branch.
  Buffer.from('\x1b[38;2;255;128;0mtruecolor span\x1b[0m\r\n', 'binary'),

  // Multi-byte UTF-8: CJK, Latin diacritics, an emoji surrogate pair.
  // Catches encoding-loss regressions in the byte → cell pipeline.
  Buffer.from('multi-byte: 中文 ünicödé 🚀\r\n', 'utf8'),

  // Save / restore cursor + absolute positioning. Catches state-machine
  // bugs in the cursor stack.
  Buffer.from('\x1b[s\x1b[10;5H\x1b[u', 'binary'),

  // Bulk write — 10KB of '.' to force scrollback rotation. Big chunks
  // are when the WASM/canvas/DOM-renderer race conditions tend to fire.
  // Smaller than a real session but big enough to shake the parser.
  Buffer.alloc(10_000, 0x2e),
  Buffer.from('\r\n', 'binary'),

  // Intentionally truncated CSI — parser must remain in a sane state and
  // not throw. xterm spec: an unfinished CSI gets aborted on the next
  // ESC. We emit one to test the abort path.
  Buffer.from('\x1b[1;', 'binary'),
  Buffer.from('\x1b[0m', 'binary'),

  // Tail sentinel — load-bearing assertion target. If any of the above
  // crashed the parser mid-stream, this never gets rendered.
  Buffer.from('\r\nMAW-LOG-SENTINEL-DONE\r\n', 'utf8')
]);

/**
 * Read the e2e user's id from the better-auth `user` table by email. The
 * bootstrap flow mirrors the same id into the legacy `users` table (which
 * remains the FK anchor for ~30 domain tables — see CLAUDE.md), so this
 * id works as `agents.user_id`, `repos.user_id`, etc. directly.
 */
function getE2eUserId(): string {
  const db = new Database(MAW_DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM user WHERE email = 'e2e@maw.local'")
      .get() as { id: string } | undefined;
    if (!row) throw new Error('terminal-log-display: e2e user missing from user table');
    return row.id;
  } finally {
    db.close();
  }
}

/**
 * Read the maw_csrf cookie Playwright already carries (seeded by the
 * global-setup login flow) so JSON API POSTs can echo it back. Same
 * pattern as agent-lifecycle.spec.ts.
 */
async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'maw_csrf');
  if (!csrf) throw new Error('terminal-log-display: maw_csrf cookie missing from storageState');
  return csrf.value;
}

/**
 * Insert a phantom exited agent — including its worktree row, agent_runs
 * row, and `terminal_log` byte payload — straight into the e2e database.
 *
 * No tmux session is created (status='exited'), no real worktree on disk
 * is required (the archive page only renders the `worktrees.path` string,
 * never opens it for the row to display). The only thing on disk that
 * needs to exist is the bare repo at REPO_HOST_PATH so `/api/repos`
 * accepted it earlier.
 */
function seedPhantomAgent(opts: {
  userId: string;
  roleId: string;
  repoId: string;
  payload: Buffer;
}): { agentId: string; taskId: string } {
  const { userId, roleId, repoId, payload } = opts;
  const now = Date.now();
  const agentId = ulid();
  const worktreeId = ulid();
  const runId = ulid();
  const taskId = ulid();
  const chunkId = ulid();

  const db = new Database(MAW_DB_PATH);
  try {
    db.transaction(() => {
      // worktrees row — required by agents.worktree_id FK. Path is
      // displayed-only; nothing reads it on the archive page.
      db.prepare(
        `INSERT INTO worktrees (id, user_id, repo_id, path, branch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'orphaned', ?, ?)`
      ).run(worktreeId, userId, repoId, `${REPO_HOST_PATH}/.maw-phantom`, 'phantom', now, now);

      // agents row — status 'exited' so it shows up on the archive page.
      // tmux_session has UNIQUE constraint, so the prefix + ulid avoids
      // collision with any real spawn.
      db.prepare(
        `INSERT INTO agents (
           id, user_id, role_id, repo_id, worktree_id, cli_kind, tmux_session,
           status, current_task_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'shell', ?, 'exited', ?, ?, ?)`
      ).run(
        agentId,
        userId,
        roleId,
        repoId,
        worktreeId,
        `${TMUX_SESSION_PREFIX}-${agentId}`,
        taskId,
        now,
        now
      );

      // tasks row — agents JOIN tasks ON current_task_id; without it the
      // archive page renders task_title as '—'. Not strictly required for
      // the test to pass, but makes the row easier to identify visually
      // when a failure pulls up the screenshot.
      db.prepare(
        `INSERT INTO tasks (id, user_id, agent_id, title, body, status, created_at, updated_at)
         VALUES (?, ?, ?, 'log-display regression', '', 'done', ?, ?)`
      ).run(taskId, userId, agentId, now, now);

      // agent_runs row — drives the started_at / ended_at columns on the
      // archive page. exit_code 0 keeps the row uncluttered.
      db.prepare(
        `INSERT INTO agent_runs (
           id, user_id, agent_id, started_at, ended_at, exit_code, reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`
      ).run(runId, userId, agentId, now - 60_000, now, now, now);

      // terminal_log row — one chunk holding the full curated payload.
      // listAllTerminalChunks orders by seq ASC then concatenates, so a
      // single seq=1 row is enough.
      db.prepare(
        `INSERT INTO terminal_log (id, user_id, agent_id, seq, ts, chunk, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
      ).run(chunkId, userId, agentId, now, payload, now, now);
    })();
  } finally {
    db.close();
  }

  return { agentId, taskId };
}

/** Best-effort cleanup of a phantom row so reruns inside one server stay tidy. */
function deletePhantomAgent(agentId: string): void {
  const db = new Database(MAW_DB_PATH);
  try {
    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  } catch {
    // ignore; ON DELETE CASCADE clears the dependent rows.
  } finally {
    db.close();
  }
}

test.describe('terminal log display regression', () => {
  let userId: string;
  let roleId: string;
  let repoId: string;
  const seededAgentIds: string[] = [];

  test.beforeAll(async ({ browser }) => {
    // Bare repo dir for /api/repos to register. WorktreeManager.initEmpty
    // git-inits it; we never actually use the worktree (status='exited').
    mkdirSync(REPO_HOST_PATH, { recursive: true });

    const context = await browser.newContext({ storageState: 'tests/e2e/auth.storage.json' });
    const page = await context.newPage();
    const csrf = await getCsrfToken(page);

    userId = getE2eUserId();

    const repoRes = await page.request.post('/api/repos', {
      data: { path: REPO_HOST_PATH, default_branch: 'main' },
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }
    });
    expect(repoRes.ok(), `create repo: ${await repoRes.text()}`).toBe(true);
    repoId = (await repoRes.json()).id;

    // Role for the FK; we never spawn from it. cli_kind matches an
    // installed adapter so DB constraints stay happy even if a future
    // migration adds a check.
    const roleRes = await page.request.post('/api/roles', {
      data: { name: 'e2e-log-display', cli_kind: 'shell', system_prompt: '' },
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }
    });
    expect(roleRes.ok(), `create role: ${await roleRes.text()}`).toBe(true);
    roleId = (await roleRes.json()).id;

    await context.close();
  });

  test.afterAll(async () => {
    for (const id of seededAgentIds) deletePhantomAgent(id);
  });

  test('Show Log paints xterm without errors for a tricky byte payload', async ({ page }) => {
    const { agentId } = seedPhantomAgent({ userId, roleId, repoId, payload: TRICKY_PAYLOAD });
    seededAgentIds.push(agentId);

    // Belt: poll the log endpoint directly first so a 5xx surfaces with a
    // clear message before the modal black-box gets blamed for a backend
    // bug. listAllTerminalChunks should return the same byte count we
    // inserted, byte-for-byte.
    const logRes = await page.request.get(`/api/agents/${agentId}/log`);
    expect(logRes.ok(), `/api/agents/${agentId}/log status=${logRes.status()}`).toBe(true);
    const logBytes = await logRes.body();
    expect(logBytes.length, 'returned log size matches seeded payload').toBe(TRICKY_PAYLOAD.length);

    // Drive the user-visible flow: archive page → click View logs.
    await page.goto(`/repos/${repoId}/archive`);
    await expect(page.getByText('log-display regression')).toBeVisible();
    await page.getByRole('button', { name: /view logs/i }).first().click();

    // 1. Modal mounts.
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();

    // 2. xterm rendered into the modal — at least one row exists.
    //    `.xterm-rows` is the same selector terminal-subscribe.spec.ts uses;
    //    its presence proves Terminal.svelte's dynamic import succeeded.
    const xtermRows = dialog.locator('.xterm-rows');
    await expect(xtermRows).toBeVisible({ timeout: 10_000 });

    // 3. Tail sentinel painted — proves bytes flowed end-to-end through
    //    xterm's parser without a mid-stream throw. If e.g. requestMode
    //    crashed on the first DECRQM byte, replay aborts and this never
    //    appears.
    await expect(xtermRows).toContainText('MAW-LOG-SENTINEL-DONE', { timeout: 10_000 });

    // The fixture asserts no pageerror / CSP violation at the end of the
    // test — that's where ReferenceError-class regressions trip.
  });
});
