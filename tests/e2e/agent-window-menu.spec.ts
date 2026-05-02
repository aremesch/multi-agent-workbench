import { execa } from 'execa';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { test, expect } from './fixtures';

/**
 * E2E coverage for the agent-window kebab menu (Show Plan / Show Log /
 * Exit Agent).
 *
 * Strategy:
 *   - Spawn a shell agent (the only adapter that runs in CI without a
 *     real CLI binary). Shell adapters declare `createWorktree: false`,
 *     so the worktrees row points at the repo root — we can drop a
 *     plan file directly into <REPO>/docs/plans/ and the GET /plan
 *     route will find it.
 *   - Drive the new GET /api/agents/[id]/plan route end-to-end: list
 *     mode, render mode, sanitization, and bad-filename rejection.
 *   - Assert the modal kebab is correctly **hidden** for shell agents
 *     (negative test for the `isCodingCliKind` gate). The unit test
 *     suite covers the positive path (kebab visible + items wired) for
 *     coding cli_kinds without needing a claude/codex/gemini binary.
 *   - Drive POST /api/agents/[id]/stop → assert DB status flips to
 *     `exited` (mirrors the agent-lifecycle.spec.ts assertion shape).
 */

const TMUX_SOCKET = 'maw';
const REPO_HOST_PATH = '/tmp/maw-e2e/test-repo-window-menu';
const MAW_DB_PATH = '/tmp/maw-e2e/maw.db';

function tmux(...args: string[]) {
  return execa('tmux', ['-L', TMUX_SOCKET, ...args], { reject: false });
}

async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'maw_csrf');
  if (!csrf) throw new Error('agent-window-menu: maw_csrf cookie missing from storageState');
  return csrf.value;
}

async function waitForSnapshotStatus(
  page: import('@playwright/test').Page,
  agentId: string,
  wanted: number,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/agents/${agentId}/snapshot`);
    last = res.status();
    if (last === wanted) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `agent-window-menu: agent ${agentId} snapshot status never reached ${wanted} (last=${last})`
  );
}

function readAgentStatus(agentId: string): string | null {
  const db = new Database(MAW_DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare('SELECT status FROM agents WHERE id = ?')
      .get(agentId) as { status: string } | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

function readAgentWorktreePath(agentId: string): string | null {
  const db = new Database(MAW_DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT w.path AS path
           FROM agents a
           JOIN worktrees w ON w.id = a.worktree_id
          WHERE a.id = ?`
      )
      .get(agentId) as { path: string } | undefined;
    return row?.path ?? null;
  } finally {
    db.close();
  }
}

async function waitForDbStatus(
  agentId: string,
  wanted: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = readAgentStatus(agentId);
    if (last === wanted) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `agent-window-menu: agent ${agentId} db status never reached "${wanted}" (last="${last}")`
  );
}

async function spawnShellAgent(
  page: import('@playwright/test').Page,
  roleId: string,
  repoId: string,
  title: string
): Promise<string> {
  const res = await page.request.post('/agents/new', {
    form: { role_id: roleId, repo_id: repoId, task_title: title, task_body: '' },
    headers: { origin: 'http://127.0.0.1:4173', accept: 'text/html' },
    maxRedirects: 0
  });
  if (res.status() !== 303) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(`spawn(${title}) expected 303, got ${res.status()}: ${body.slice(0, 500)}`);
  }
  const loc = res.headers()['location'] ?? '';
  const m = /\/agents\/([A-Z0-9]+)$/.exec(loc);
  if (!m?.[1]) throw new Error(`agent-window-menu: no agent id in redirect "${loc}"`);
  return m[1];
}

test.describe('agent-window kebab menu', () => {
  let roleId: string;
  let repoId: string;
  const spawned: string[] = [];

  /**
   * Aggressively kill every spawned agent's tmux session after each test
   * so subsequent test files don't inherit live runtimes that slow the
   * shared dev server. Idempotent — `tmux kill-session` against a missing
   * target exits non-zero, and `reject:false` swallows that.
   */
  test.afterEach(async () => {
    while (spawned.length) {
      const agentId = spawned.pop()!;
      await tmux('kill-session', '-t', `maw-agent-${agentId}`);
    }
  });

  test.beforeAll(async ({ browser }) => {
    mkdirSync(REPO_HOST_PATH, { recursive: true });

    const context = await browser.newContext({ storageState: 'tests/e2e/auth.storage.json' });
    const page = await context.newPage();
    const csrf = await getCsrfToken(page);

    const repoRes = await page.request.post('/api/repos', {
      data: { path: REPO_HOST_PATH, default_branch: 'main' },
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }
    });
    expect(repoRes.ok(), `create repo: ${await repoRes.text()}`).toBe(true);
    repoId = (await repoRes.json()).id;

    const roleRes = await page.request.post('/api/roles', {
      data: { name: 'e2e-window-menu-shell', cli_kind: 'shell', system_prompt: '' },
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }
    });
    expect(roleRes.ok(), `create role: ${await roleRes.text()}`).toBe(true);
    roleId = (await roleRes.json()).id;

    await context.close();
  });

  test.afterAll(async () => {
    // afterEach drains `spawned` already, but a test that errors mid-flight
    // could leave the array non-empty.
    for (const agentId of spawned) {
      await tmux('kill-session', '-t', `maw-agent-${agentId}`);
    }
  });

  test('GET /api/agents/[id]/plan returns the list, render, and rejects bad filenames', async ({
    page
  }) => {
    const agentId = await spawnShellAgent(page, roleId, repoId, 'e2e-plan-route');
    spawned.push(agentId);
    await waitForSnapshotStatus(page, agentId, 200);

    const wtPath = readAgentWorktreePath(agentId);
    expect(wtPath, 'worktree path resolved from db').not.toBeNull();
    const plansDir = join(wtPath!, 'docs', 'plans');
    mkdirSync(plansDir, { recursive: true });

    // A benign plan + a malicious plan (script tag) so we can assert the
    // sanitizer drops it.
    writeFileSync(join(plansDir, 'plan-one.md'), '# Plan one\n\n- item a\n- item b\n');
    writeFileSync(
      join(plansDir, 'plan-evil.md'),
      '# evil\n\n<script>window.exfil = 1</script>\n\nbody text'
    );

    // Commit them — listAgentPlans filters by `git diff` since the agent's
    // base_sha is captured at spawn. Untracked files would also show up via
    // `git status` but only if the path stays inside docs/plans relative to
    // the repo root, which it does. Committing is the most-portable signal.
    await execa('git', ['-C', wtPath!, 'config', 'user.email', 'e2e@test.local']);
    await execa('git', ['-C', wtPath!, 'config', 'user.name', 'e2e']);
    await execa('git', ['-C', wtPath!, 'add', 'docs/plans']);
    await execa('git', ['-C', wtPath!, 'commit', '-m', 'e2e: add test plans']);

    // --- list mode ---
    const listRes = await page.request.get(`/api/agents/${agentId}/plan`);
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    expect(list.dir).toBe('docs/plans');
    const names = (list.files as Array<{ name: string }>).map((f) => f.name).sort();
    expect(names).toEqual(['plan-evil.md', 'plan-one.md']);

    // --- render mode (benign) ---
    const benignRes = await page.request.get(
      `/api/agents/${agentId}/plan?file=plan-one.md`
    );
    expect(benignRes.status()).toBe(200);
    const benign = await benignRes.json();
    expect(benign.name).toBe('plan-one.md');
    expect(benign.html).toContain('Plan one');
    expect(benign.html).toContain('item a');

    // --- render mode (malicious payload sanitized) ---
    const evilRes = await page.request.get(
      `/api/agents/${agentId}/plan?file=plan-evil.md`
    );
    expect(evilRes.status()).toBe(200);
    const evil = await evilRes.json();
    expect(evil.name).toBe('plan-evil.md');
    expect(evil.html).not.toContain('<script');
    expect(evil.html).not.toContain('window.exfil');
    expect(evil.html).toContain('body text');

    // --- bad filename rejected with 400 ---
    const badRes = await page.request.get(
      `/api/agents/${agentId}/plan?file=${encodeURIComponent('../../etc/passwd')}`
    );
    expect(badRes.status()).toBe(400);
    expect((await badRes.json()).code).toBe('invalid_filename');

    // --- missing file → 404 ---
    const missingRes = await page.request.get(`/api/agents/${agentId}/plan?file=gone.md`);
    expect(missingRes.status()).toBe(404);
    expect((await missingRes.json()).code).toBe('plan_not_found');
  });

  test('shell agent modal does NOT render the kebab (cli_kind gating)', async ({ page }) => {
    const agentId = await spawnShellAgent(page, roleId, repoId, 'e2e-no-kebab-shell');
    spawned.push(agentId);
    await waitForSnapshotStatus(page, agentId, 200);

    await page.goto(`/repos/${repoId}?agent=${agentId}`);
    // Wait for the dashboard hydration to finish + the modal to be open.
    // The modal's xterm panel renders inside .maw-modal-body; we just need
    // *any* signal that the page is interactive.
    await expect(page.locator('.maw-modal[open]')).toBeVisible({ timeout: 10_000 });

    // The kebab uses aria-label "agentMenu.button" via the i18n key. The
    // real translator resolves it to "Agent menu" (en) — pick whichever the
    // current locale serves; either way the button must NOT be in the DOM.
    const kebabByLabel = page.getByRole('button', { name: /Agent menu|Agent-Menü|Menú del agente|Menu de l’agent/ });
    await expect(kebabByLabel).toHaveCount(0);
  });

  test('Exit Agent flow: POST /stop flips DB status to exited', async ({ page }) => {
    const agentId = await spawnShellAgent(page, roleId, repoId, 'e2e-exit-flow');
    spawned.push(agentId);
    await waitForSnapshotStatus(page, agentId, 200);
    expect(readAgentStatus(agentId)).toBe('running');

    const csrf = await getCsrfToken(page);
    const stopRes = await page.request.post(`/api/agents/${agentId}/stop`, {
      headers: { 'x-csrf-token': csrf }
    });
    expect(stopRes.ok(), `stop: ${stopRes.status()} ${await stopRes.text()}`).toBe(true);
    expect((await stopRes.json()).status).toBe('exited');

    await waitForDbStatus(agentId, 'exited');
  });
});
