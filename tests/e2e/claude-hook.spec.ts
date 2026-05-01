import { execa } from 'execa';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { test, expect } from './fixtures';

/**
 * E2E for the Claude Code hook receiver route at
 * `/api/internal/claude-hook`. Spawns a `shell` agent (so we don't need
 * a real `claude` CLI installed in CI), patches a hook bearer token
 * directly into its DB row, then POSTs a synthetic `Notification`
 * payload to the route — the kind of payload claude-code sends on stdin
 * to its hook command — and asserts:
 *
 *   1. The route returns 204.
 *   2. A row is created in `alerts` with the agent's id and a payload
 *      detail surfacing `tool_name` + `tool_input.command`.
 *   3. An `events` row of kind `prompt_detected` is also created.
 *
 * Also validates the loopback-only enforcement is permissive of the
 * default Playwright client (which connects to 127.0.0.1) and the
 * 401/403 paths via direct request crafting.
 */

const TMUX_SOCKET = 'maw';
const REPO_HOST_PATH = '/tmp/maw-e2e/test-repo';
const MAW_DB_PATH = '/tmp/maw-e2e/maw.db';

function tmux(...args: string[]) {
  return execa('tmux', ['-L', TMUX_SOCKET, ...args], { reject: false });
}

async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'maw_csrf');
  if (!csrf) throw new Error('claude-hook: maw_csrf cookie missing from storageState');
  return csrf.value;
}

async function spawnShellAgent(
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
    throw new Error(`spawn(${title}) expected 303, got ${res.status()}: ${body.slice(0, 500)}`);
  }
  const loc = res.headers()['location'] ?? '';
  const m = /\/agents\/([A-Z0-9]+)$/.exec(loc);
  if (!m?.[1]) throw new Error(`claude-hook: no agent id in redirect "${loc}"`);
  return m[1];
}

/** Patch a hook_token onto an existing agent row so we can validate the
 *  receiver route end-to-end without actually spawning claude-code. */
function setHookTokenForAgent(agentId: string, token: string): void {
  const db = new Database(MAW_DB_PATH);
  try {
    db.prepare('UPDATE agents SET hook_token = ? WHERE id = ?').run(token, agentId);
  } finally {
    db.close();
  }
}

/** Read alerts for a given agent_id, ordered by ts ascending. */
function readAlertsForAgent(agentId: string): Array<{
  id: string;
  reason: string;
  payload_json: string;
}> {
  const db = new Database(MAW_DB_PATH, { readonly: true });
  try {
    return db
      .prepare('SELECT id, reason, payload_json FROM alerts WHERE agent_id = ? ORDER BY ts')
      .all(agentId) as Array<{ id: string; reason: string; payload_json: string }>;
  } finally {
    db.close();
  }
}

function readEventsForAgent(agentId: string): Array<{ kind: string; payload_json: string }> {
  const db = new Database(MAW_DB_PATH, { readonly: true });
  try {
    return db
      .prepare('SELECT kind, payload_json FROM events WHERE agent_id = ? ORDER BY ts')
      .all(agentId) as Array<{ kind: string; payload_json: string }>;
  } finally {
    db.close();
  }
}

test.describe('claude-hook receiver', () => {
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
      data: { name: 'e2e-claude-hook-shell', cli_kind: 'shell', system_prompt: '' },
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

  test('valid hook payload creates an alert with rich detail', async ({ page }) => {
    const agentId = await spawnShellAgent(page, roleId, repoId, 'e2e-hook-valid');
    spawned.push(agentId);
    setHookTokenForAgent(agentId, 'tok-e2e-valid');

    // Synthetic Notification event — the shape Claude Code's hook
    // emits on stdin: hook_event_name + notification_type +
    // tool_name + tool_input + tool_use_id.
    const payload = {
      hook_event_name: 'Notification',
      session_id: 'sess-e2e-1',
      notification_type: 'permission_prompt',
      tool_name: 'Bash',
      tool_input: { command: 'ls /tmp' },
      tool_use_id: 'tu-e2e-1'
    };

    const res = await page.request.post('/api/internal/claude-hook', {
      headers: {
        authorization: 'Bearer tok-e2e-valid',
        'content-type': 'application/json'
      },
      data: JSON.stringify(payload)
    });
    expect(res.status()).toBe(204);

    // Allow the runtime's processEvent → maybeAlert path to settle. The
    // hook handler itself is synchronous after json parse, but the
    // alert insert + push notify chain has a tick or two of async.
    await new Promise((r) => setTimeout(r, 300));

    const alerts = readAlertsForAgent(agentId);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const alert = alerts[alerts.length - 1]!;

    // Reason: agentDisplayName(task title or cli_kind) + permission needed: <tool>
    expect(alert.reason).toContain('Permission needed');
    expect(alert.reason).toContain('Bash');

    const detail = JSON.parse(alert.payload_json) as {
      patternId?: string;
      detail?: Record<string, unknown>;
      body?: string;
      source?: string;
    };
    expect(detail.source).toBe('hook');
    expect(detail.patternId).toBe('claude_hook_permission_prompt');
    expect(detail.detail?.tool).toBe('Bash');
    expect(detail.detail?.cmd).toBe('ls /tmp');
    expect(detail.body).toContain('ls /tmp');

    // Events row mirrors it.
    const events = readEventsForAgent(agentId);
    const promptEvents = events.filter((e) => e.kind === 'prompt_detected');
    expect(promptEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('unknown bearer token returns 401 without side effects', async ({ page }) => {
    const agentId = await spawnShellAgent(page, roleId, repoId, 'e2e-hook-401');
    spawned.push(agentId);
    // Deliberately do NOT set the hook token.

    const before = readAlertsForAgent(agentId).length;

    const res = await page.request.post('/api/internal/claude-hook', {
      headers: {
        authorization: 'Bearer no-such-token',
        'content-type': 'application/json'
      },
      data: JSON.stringify({ hook_event_name: 'Notification' })
    });
    expect(res.status()).toBe(401);

    await new Promise((r) => setTimeout(r, 200));
    const after = readAlertsForAgent(agentId).length;
    expect(after).toBe(before);
  });

  test('missing authorization header returns 401', async ({ page }) => {
    const res = await page.request.post('/api/internal/claude-hook', {
      headers: { 'content-type': 'application/json' },
      data: '{}'
    });
    expect(res.status()).toBe(401);
  });
});
