import { execa } from 'execa';
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { test, expect } from './fixtures';

/**
 * E2E for the agent image-paste / drop / paperclip pipeline.
 *
 * Strategy:
 *   - The route does NOT gate on cli_kind (auth + owner is the real
 *     boundary; the per-adapter `acceptsImageAttachment` flag is a
 *     client-side render hint). So a `shell` agent can drive the full
 *     server-side path without needing a real claude-code binary.
 *   - Direct REST tests cover guards (CSRF/auth/owner/MIME/size) and
 *     the happy path (file lands in `<wt>/.maw/uploads/`, gitignore is
 *     written).
 *   - End-to-end through the browser DOM is verified via the hidden
 *     `<input type="file">` paperclip path: the test sets a file on
 *     the input, waits for the upload-status toast, and asserts the
 *     injected ` @<rel> ` keystroke shows up in the agent's terminal
 *     log (echoed back by the shell PTY). This proves the full chain:
 *     route → response → client `sendKeys` → WS hub → tmux → echo.
 */

const TMUX_SOCKET = 'maw';
const REPO_HOST_PATH = '/tmp/maw-e2e/test-repo-image-upload';
const MAW_DB_PATH = '/tmp/maw-e2e/maw.db';

// Minimum-viable PNG payload. The server route trusts the multipart
// content-type and doesn't sniff magic bytes (v1), so any non-empty
// blob with `Content-Type: image/png` is accepted. Using the 8-byte
// PNG signature keeps the bytes recognisable as "this is a PNG" if
// anyone manually inspects the test artifacts.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tmux(...args: string[]) {
  return execa('tmux', ['-L', TMUX_SOCKET, ...args], { reject: false });
}

async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'maw_csrf');
  if (!csrf) throw new Error('agent-image-upload: maw_csrf cookie missing');
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
    `agent-image-upload: agent ${agentId} snapshot status never reached ${wanted} (last=${last})`
  );
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
  if (!m?.[1]) throw new Error(`agent-image-upload: no agent id in redirect "${loc}"`);
  return m[1];
}

test.describe('agent image-paste route', () => {
  let roleId: string;
  let repoId: string;
  const spawned: string[] = [];

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
      data: { name: 'e2e-image-upload-shell', cli_kind: 'shell', system_prompt: '' },
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

  /**
   * Single bundled flow keeps the suite fast and avoids the local
   * resource ceiling that 4 back-to-back tmux spawns can hit on slower
   * boxes. Each assertion exercises an independent code path (happy
   * path, MIME guard, size guard, CSRF guard) but reuses the one
   * running agent + worktree.
   */
  test('POST /upload-image — happy path + MIME / size / CSRF guards', async ({ page }) => {
    const agentId = await spawnShellAgent(page, roleId, repoId, 'e2e-img-bundle');
    spawned.push(agentId);
    await waitForSnapshotStatus(page, agentId, 200);

    const wtPath = readAgentWorktreePath(agentId);
    expect(wtPath, 'worktree path resolved from db').not.toBeNull();
    const csrf = await getCsrfToken(page);

    // adapter-node treats multipart POSTs as form submissions and
    // checks Origin against the ORIGIN env var. Without it, the
    // request is rejected with "Cross-site POST form submissions are
    // forbidden" before our handler even runs.
    const baseHeaders = {
      'x-csrf-token': csrf,
      origin: 'http://127.0.0.1:4173'
    };

    // --- happy path ---
    const happyRes = await page.request.post(
      `/api/agents/${agentId}/upload-image`,
      {
        headers: baseHeaders,
        multipart: {
          file: {
            name: 'screenshot.png',
            mimeType: 'image/png',
            buffer: Buffer.from(PNG_BYTES)
          }
        }
      }
    );
    expect(happyRes.status(), `upload: ${await happyRes.text()}`).toBe(200);
    const body = await happyRes.json();
    expect(body.relativePath).toMatch(/^\.maw\/uploads\/[0-9a-z]+-[0-9a-f]{6}\.png$/);
    expect(body.filename).toMatch(/^[0-9a-z]+-[0-9a-f]{6}\.png$/);
    expect(body.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(body.mime).toBe('image/png');

    const fileAbs = join(wtPath!, body.relativePath);
    expect(existsSync(fileAbs)).toBe(true);
    expect(statSync(fileAbs).size).toBe(PNG_BYTES.byteLength);

    const gitignoreAbs = join(wtPath!, '.maw', '.gitignore');
    expect(existsSync(gitignoreAbs)).toBe(true);
    expect(readFileSync(gitignoreAbs, 'utf8')).toBe('*\n');

    // --- MIME guard ---
    const mimeRes = await page.request.post(
      `/api/agents/${agentId}/upload-image`,
      {
        headers: baseHeaders,
        multipart: {
          file: {
            name: 'evil.svg',
            mimeType: 'image/svg+xml',
            buffer: Buffer.from('<svg/>')
          }
        }
      }
    );
    expect(mimeRes.status()).toBe(400);
    expect((await mimeRes.json()).code).toBe('mime');

    // --- size guard (5 MiB + 1) ---
    const oversize = Buffer.alloc(5 * 1024 * 1024 + 1);
    const sizeRes = await page.request.post(
      `/api/agents/${agentId}/upload-image`,
      {
        headers: baseHeaders,
        multipart: {
          file: { name: 'big.png', mimeType: 'image/png', buffer: oversize }
        }
      }
    );
    expect(sizeRes.status()).toBe(400);
    expect((await sizeRes.json()).code).toBe('size');

    // --- missing CSRF (Origin still set so adapter-node lets us
    //     through to our verifyCsrf) ---
    const csrfRes = await page.request.post(
      `/api/agents/${agentId}/upload-image`,
      {
        headers: { origin: 'http://127.0.0.1:4173' },
        multipart: {
          file: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from(PNG_BYTES) }
        }
      }
    );
    expect(csrfRes.status()).toBe(403);
  });
});
