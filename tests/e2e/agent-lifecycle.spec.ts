import { execa } from 'execa';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { test, expect } from './fixtures';

/**
 * Agent-lifecycle e2e — regression guard for the session-closed hook
 * cascade bug (commit 33c4089).
 *
 * Spawns two `shell` agents, sends `exit` into the 2nd via
 * `tmux send-keys`, and asserts that ONLY the 2nd transitions to exited
 * while the 1st stays alive. Catches any regression in the chain
 * `tmux session-closed → wait-for → AgentSupervisor.finishAsExited`
 * reaping the wrong agent.
 *
 * See docs/plans/v0.2-playwright-agent-lifecycle-e2e.md for the why.
 */

const TMUX_SOCKET = 'maw';
const REPO_HOST_PATH = '/tmp/maw-e2e/test-repo';
const MAW_DB_PATH = '/tmp/maw-e2e/maw.db';

/**
 * Run `tmux -L maw …` on the host. reject:false so callers can observe
 * the exit code directly (e.g. has-session returns 1 for missing).
 */
function tmux(...args: string[]) {
  return execa('tmux', ['-L', TMUX_SOCKET, ...args], { reject: false });
}

/**
 * Read the `maw_csrf` cookie Playwright already carries (seeded by
 * global-setup's login flow) so JSON API POSTs can echo it back in the
 * `x-csrf-token` header — src/lib/server/auth/csrf.ts:34-40.
 */
async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'maw_csrf');
  if (!csrf) throw new Error('agent-lifecycle: maw_csrf cookie missing from storageState');
  return csrf.value;
}

/** Poll the snapshot route until it returns the expected status, or time out. */
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
    `agent-lifecycle: agent ${agentId} snapshot status never reached ${wanted} (last=${last})`
  );
}

/**
 * Read the agent's `status` column directly from the sqlite DB.
 *
 * The snapshot route alone isn't enough to catch the cascade bug: under
 * the old code, agent 1's DB status flips to `exited` while its tmux
 * session stays alive, so `hasSession` still returns 200 even though the
 * supervisor has already reaped the runtime. The DB is the single
 * source of truth for agent status — read it directly so we can't be
 * fooled by a zombie tmux session.
 *
 * Opened readonly per call (cheap) so we never hold a lock that the
 * server would notice.
 */
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
    `agent-lifecycle: agent ${agentId} db status never reached "${wanted}" (last="${last}")`
  );
}

/**
 * Spawn a shell agent via the real form action. Returns the agent id
 * parsed from the 303 redirect to /agents/<id>.
 *
 * We set Origin explicitly because SvelteKit's built-in form-action CSRF
 * protection (enabled by default) rejects any POST whose Origin header
 * doesn't match the request URL's origin — and Playwright's APIRequestContext
 * does NOT send Origin automatically for non-browser requests. The
 * webServer config already declares `ORIGIN=http://127.0.0.1:4173` for
 * adapter-node; we echo the same baseURL here.
 */
async function spawnAgent(
  page: import('@playwright/test').Page,
  roleId: string,
  repoId: string,
  title: string
): Promise<string> {
  const res = await page.request.post('/agents/new', {
    form: {
      role_id: roleId,
      repo_id: repoId,
      task_title: title,
      task_body: ''
    },
    headers: {
      // Match the ORIGIN envvar the webServer boots with — SvelteKit's
      // default form-action CSRF rejects any mismatch.
      origin: 'http://127.0.0.1:4173',
      // Ask for text/html so SvelteKit uses its non-enhance branch and
      // returns 303 See Other on success. With the default Accept SvelteKit
      // serializes the action result as JSON with a 200, which is fine for
      // use:enhance but makes this test's "success = 303" assertion brittle.
      accept: 'text/html'
    },
    maxRedirects: 0
  });
  // SvelteKit form actions return 303 See Other → /agents/<ulid> on success.
  // Any other status means the action returned fail(…) — dump the body so
  // the test failure points straight at the cause (unknown role, path
  // collision, etc.) instead of a cryptic status mismatch.
  if (res.status() !== 303) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(
      `spawn(${title}) expected 303 redirect, got ${res.status()}: ${body.slice(0, 500)}`
    );
  }
  const loc = res.headers()['location'] ?? '';
  const m = /\/agents\/([A-Z0-9]+)$/.exec(loc);
  if (!m?.[1]) throw new Error(`agent-lifecycle: no agent id in redirect "${loc}"`);
  return m[1];
}

test.describe('agent lifecycle', () => {
  let roleId: string;
  let repoId: string;
  const spawned: string[] = [];

  test.beforeAll(async ({ browser }) => {
    // Playwright's webServer config nukes /tmp/maw-e2e before starting the
    // server, and MAW's bootstrap re-creates the data dir on first boot.
    // The host repo path lives inside it so it too gets wiped between
    // runs; mkdir is idempotent so reruns of beforeAll within one run
    // are fine.
    mkdirSync(REPO_HOST_PATH, { recursive: true });

    const context = await browser.newContext({ storageState: 'tests/e2e/auth.storage.json' });
    const page = await context.newPage();
    const csrf = await getCsrfToken(page);

    // 1. Register the empty dir as a MAW repo. WorktreeManager.initEmpty
    //    handles git-init + initial commit.
    const repoRes = await page.request.post('/api/repos', {
      data: { path: REPO_HOST_PATH, default_branch: 'main' },
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }
    });
    expect(repoRes.ok(), `create repo: ${await repoRes.text()}`).toBe(true);
    repoId = (await repoRes.json()).id;

    // 2. Create a shell role — the `shell` adapter is already in
    //    cli-adapters/shell.jsonc and spawns `bash -i`.
    const roleRes = await page.request.post('/api/roles', {
      data: { name: 'e2e-shell', cli_kind: 'shell', system_prompt: '' },
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }
    });
    expect(roleRes.ok(), `create role: ${await roleRes.text()}`).toBe(true);
    roleId = (await roleRes.json()).id;

    await context.close();
  });

  test.afterAll(async () => {
    // Always kill every session we spawned, even if an assertion failed
    // mid-test — otherwise a crashed run leaves `maw-agent-*` ghosts on
    // the shared -L maw socket. reject:false in tmux() swallows "can't
    // find session" for sessions the test already closed.
    for (const agentId of spawned) {
      await tmux('kill-session', '-t', `maw-agent-${agentId}`);
    }
  });

  test('exit in one shell agent does not cascade-reap the others', async ({ page }) => {
    // --- Arrange: two live agents -----------------------------------------
    const agent1 = await spawnAgent(page, roleId, repoId, 'e2e-cascade-one');
    spawned.push(agent1);
    const agent2 = await spawnAgent(page, roleId, repoId, 'e2e-cascade-two');
    spawned.push(agent2);

    // Wait for both to be serving a live pane (200 from snapshot) — bash
    // may take a tick to print its first prompt, so the pipe-pane / FIFO
    // chain needs a moment to come up after Tmux.newSession returns.
    await waitForSnapshotStatus(page, agent1, 200);
    await waitForSnapshotStatus(page, agent2, 200);

    // Belt-and-braces: confirm both tmux sessions exist from the host's
    // perspective too, so a false positive in the snapshot route (e.g.
    // 200 on a nearly-dead pane) can't mask a regression.
    expect((await tmux('has-session', '-t', `maw-agent-${agent1}`)).exitCode).toBe(0);
    expect((await tmux('has-session', '-t', `maw-agent-${agent2}`)).exitCode).toBe(0);

    // --- Act: type `exit\n` into agent 2's bash ---------------------------
    // `-l` = literal (so 'exit' isn't interpreted as the tmux key name
    // 'Escape' or similar). Follow with a named Enter key.
    await tmux('send-keys', '-t', `maw-agent-${agent2}`, '-l', 'exit');
    await tmux('send-keys', '-t', `maw-agent-${agent2}`, 'Enter');

    // --- Assert: only agent 2 transitions to exited -----------------------
    // Wait for the supervisor to notice agent 2's session closed. Polling
    // the snapshot route also fires the route's own `reapAgent` side
    // effect, which guarantees the DB row is flipped to 'exited' — so
    // by the time waitForSnapshotStatus returns, agent 2's row is settled.
    await waitForSnapshotStatus(page, agent2, 410);
    expect(readAgentStatus(agent2), 'agent-2 should be exited after its bash closed').toBe(
      'exited'
    );

    // The load-bearing assertion: agent 1's DB status must still be
    // 'running'. Under the old per-session hook bug, tmux fires agent 1's
    // stored hook when agent 2 closes → agent 1's exit waiter resolves →
    // `finishAsExited(agent1)` runs → DB status flips to 'exited'. The
    // snapshot route alone would NOT catch this, because agent 1's tmux
    // session is still alive (the bug only signals the channel, doesn't
    // kill the session) — `hasSession` returns true, so the route would
    // return 200 even though the supervisor has already reaped agent 1.
    // The DB is the only signal that distinguishes "alive" from "zombie
    // runtime"; read it directly.
    //
    // Give the (broken) cascade path a generous window to fire — the
    // hook fires within ms but we want to be sure we're asserting on a
    // settled state, not racing it.
    await new Promise((r) => setTimeout(r, 500));
    expect(
      readAgentStatus(agent1),
      'cascade bug regressed: closing agent-2 flipped agent-1 to exited in the DB'
    ).toBe('running');

    // Belt-and-braces: agent 1's tmux session also still exists.
    expect(
      (await tmux('has-session', '-t', `maw-agent-${agent1}`)).exitCode,
      'cascade bug regressed: agent-1 tmux session was killed when agent-2 exited'
    ).toBe(0);
  });
});
