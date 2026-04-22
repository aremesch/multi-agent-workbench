import { execa } from 'execa';
import { mkdirSync } from 'node:fs';
import { test, expect } from './fixtures';

/**
 * Minimal "subscribe renders output" smoke for the pane-snapshot
 * reconnect path (protocol v5).
 *
 * Spawns a shell agent, types a unique marker into its tmux pane via
 * `tmux send-keys`, then opens the per-repo dashboard modal with the
 * agent pre-selected and asserts the marker appears in the xterm DOM.
 * That's the smallest assertion that proves the full chain still works:
 * CS_SubscribeAgent → server runs `tmux capture-pane -p -e -S 0` →
 * ships `SC_PaneSnapshot` → client `term.reset()` + writes ansi → DOM
 * paints. A second assertion closes the modal and reopens it to prove
 * the reattach path paints the same marker from the current tmux grid,
 * not a stale replay.
 */

const TMUX_SOCKET = 'maw';
const REPO_HOST_PATH = '/tmp/maw-e2e/test-repo-subscribe';

function tmux(...args: string[]) {
  return execa('tmux', ['-L', TMUX_SOCKET, ...args], { reject: false });
}

async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'maw_csrf');
  if (!csrf) throw new Error('terminal-subscribe: maw_csrf cookie missing from storageState');
  return csrf.value;
}

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
      origin: 'http://127.0.0.1:4173',
      accept: 'text/html'
    },
    maxRedirects: 0
  });
  if (res.status() !== 303) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(
      `spawn(${title}) expected 303 redirect, got ${res.status()}: ${body.slice(0, 500)}`
    );
  }
  const loc = res.headers()['location'] ?? '';
  const m = /\/agents\/([A-Z0-9]+)$/.exec(loc);
  if (!m?.[1]) throw new Error(`terminal-subscribe: no agent id in redirect "${loc}"`);
  return m[1];
}

test.describe('terminal subscribe', () => {
  let roleId: string;
  let repoId: string;
  const spawned: string[] = [];

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
      data: { name: 'e2e-shell-subscribe', cli_kind: 'shell', system_prompt: '' },
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }
    });
    expect(roleRes.ok(), `create role: ${await roleRes.text()}`).toBe(true);
    roleId = (await roleRes.json()).id;

    await context.close();
  });

  test.afterAll(async () => {
    for (const agentId of spawned) {
      await tmux('kill-session', '-t', `maw-agent-${agentId}`);
    }
  });

  test('pane snapshot paints current tmux grid into xterm on subscribe and reopen', async ({
    page
  }) => {
    const agentId = await spawnAgent(page, roleId, repoId, 'e2e-subscribe-marker');
    spawned.push(agentId);

    // Wait until the tmux session exists from the host's perspective so
    // send-keys lands in the pane and not on the floor.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const probe = await tmux('has-session', '-t', `maw-agent-${agentId}`);
      if (probe.exitCode === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await tmux('has-session', '-t', `maw-agent-${agentId}`)).exitCode).toBe(0);

    // Type the marker into bash. -l = literal so the string is sent
    // verbatim, not interpreted as a tmux key name. Follow with Enter so
    // bash actually executes echo and the result lands in the pane (and
    // therefore in tmux's visible grid) before we navigate.
    await tmux('send-keys', '-t', `maw-agent-${agentId}`, '-l', 'echo maw-subscribe-marker');
    await tmux('send-keys', '-t', `maw-agent-${agentId}`, 'Enter');

    // Give the pane a moment so capture-pane sees the echo output.
    await new Promise((r) => setTimeout(r, 500));

    // Open the per-repo dashboard with the agent pre-selected — the modal
    // mounts, AgentTerminalPanel calls subscribe(), and the server replies
    // with a SC_PaneSnapshot carrying the current visible pane as ANSI.
    await page.goto(`/repos/${repoId}?agent=${agentId}`);

    // Poll the xterm DOM for the marker. Generous timeout because xterm's
    // dynamic import + first paint after subscribe takes a moment in CI.
    await expect(page.locator('.xterm-rows')).toContainText('maw-subscribe-marker', {
      timeout: 15_000
    });

    // Close the modal (drop the ?agent= param) and reopen it. The panel
    // remounts with a fresh xterm; the server sends a new pane_snapshot
    // built from the same live tmux grid. Proves the reattach path does
    // not stack or lose content.
    await page.goto(`/repos/${repoId}`);
    await expect(page.locator('.xterm-rows')).toHaveCount(0);
    await page.goto(`/repos/${repoId}?agent=${agentId}`);
    await expect(page.locator('.xterm-rows')).toContainText('maw-subscribe-marker', {
      timeout: 15_000
    });
  });
});
