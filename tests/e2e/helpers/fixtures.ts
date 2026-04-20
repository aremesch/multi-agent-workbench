import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';

/**
 * SvelteKit's built-in CSRF guard rejects cross-site form POSTs by comparing
 * `request.headers.origin` against the request URL. Playwright's
 * `APIRequestContext.post` doesn't populate Origin automatically for non-page
 * requests, so we attach it explicitly from the test project's baseURL on
 * every form-style POST. JSON `+server.ts` routes use double-submit CSRF via
 * `x-csrf-token` instead and don't need the header, but it's harmless there.
 */
function originHeader(_page: Page): Record<string, string> {
  const baseURL =
    (test.info().project.use.baseURL as string | undefined) ??
    process.env.MAW_E2E_URL ??
    'http://127.0.0.1:4173';
  const u = new URL(baseURL);
  return { origin: `${u.protocol}//${u.host}` };
}

/**
 * Read the `maw_csrf` cookie the server set so we can echo it in the
 * `x-csrf-token` header. JSON `+server.ts` routes enforce double-submit
 * CSRF — see src/lib/server/auth/csrf.ts. Form-action POSTs are covered
 * by SvelteKit's built-in Origin check and don't need the header.
 */
async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const c = cookies.find((x) => x.name === 'maw_csrf');
  if (c) return c.value;
  // No cookie yet — navigate once to /login so the server seeds it, then retry.
  await page.goto('/login');
  const retry = (await page.context().cookies()).find((x) => x.name === 'maw_csrf');
  if (!retry) throw new Error('maw_csrf cookie never set — server may not be reachable');
  return retry.value;
}

async function postJson<T>(page: Page, path: string, body: unknown): Promise<T> {
  const token = await csrfToken(page);
  const res = await page.request.post(path, {
    data: body as Record<string, unknown>,
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' }
  });
  if (!res.ok()) throw new Error(`POST ${path} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Create a fresh E2E-scoped project. Cheap enough to make per test. */
export async function createProject(
  page: Page,
  name = `e2e-${Date.now()}`
): Promise<{ id: string; name: string }> {
  return postJson(page, '/api/projects', { name, default_branch: 'main' });
}

/**
 * Create a throwaway empty directory and register it as a repo. The server
 * auto-runs `git init` on empty dirs per v0.1's self-healing repo attach.
 */
export async function createRepo(
  page: Page,
  project_id: string
): Promise<{ id: string; path: string }> {
  const path = mkdtempSync(join(tmpdir(), 'maw-e2e-repo-'));
  const body = await postJson<{ id: string; path: string; projectName: string }>(
    page,
    '/api/repos',
    { project_id, path, origin_url: null }
  );
  return { id: body.id, path: body.path };
}

export async function createRole(
  page: Page,
  cli_kind: string,
  name = `e2e-${cli_kind}-${Date.now()}`
): Promise<{ id: string; name: string }> {
  return postJson(page, '/api/roles', { name, cli_kind, system_prompt: '' });
}

/**
 * Probe for whether the server has a given CLI kind registered. The
 * `/api/roles` POST validates `cli_kind` against the adapter registry, so a
 * successful create implies the kind is known. We create one probe role per
 * test run — it'll linger on the server but is harmless and tagged so the
 * user can sweep them out manually.
 */
export async function cliKindAvailable(page: Page, cli_kind: string): Promise<boolean> {
  const token = await csrfToken(page);
  const res = await page.request.post('/api/roles', {
    data: { name: `probe-${cli_kind}-${Date.now()}`, cli_kind, system_prompt: '' },
    headers: { 'x-csrf-token': token, 'content-type': 'application/json' }
  });
  return res.ok();
}

/**
 * Spawn an agent via the same form action the UI uses. The handler responds
 * 303 to `/agents/<id>`; we disable redirect following and pull the id from
 * the Location header so the test doesn't depend on the destination page
 * being reachable at the exact moment we POST.
 */
export async function spawnAgent(
  page: Page,
  args: { role_id: string; repo_id: string; task_title?: string; task_body?: string }
): Promise<{ id: string }> {
  const form: Record<string, string> = {
    role_id: args.role_id,
    repo_id: args.repo_id,
    task_title: args.task_title ?? '',
    task_body: args.task_body ?? ''
  };
  const res = await page.request.post('/agents/new', {
    form,
    headers: originHeader(page),
    maxRedirects: 0,
    failOnStatusCode: false
  });
  // SvelteKit form actions often return 303 with the redirect location; some
  // branch returns 200 with a SvelteKit ActionResult envelope on async ops.
  if (res.status() === 303) {
    const location = res.headers()['location'] ?? '';
    const m = /\/agents\/([^/?#]+)/.exec(location);
    if (!m) throw new Error(`spawnAgent: no agent id in Location: ${location}`);
    return { id: m[1] };
  }
  if (res.status() === 200) {
    // SvelteKit wraps redirects in { type: 'redirect', location } when fetched
    // with the form-action convention and `x-sveltekit-action` semantics.
    const body = (await res.json()) as { type?: string; location?: string };
    if (body.type === 'redirect' && body.location) {
      const m = /\/agents\/([^/?#]+)/.exec(body.location);
      if (m) return { id: m[1] };
    }
  }
  throw new Error(`spawnAgent unexpected response ${res.status()}: ${await res.text()}`);
}

/** Hard-delete an agent (kills tmux + removes worktree). */
export async function deleteAgent(page: Page, id: string): Promise<void> {
  const token = await csrfToken(page).catch(() => '');
  await page.request
    .delete(`/api/agents/${id}?removeWorktree=1`, {
      headers: token ? { 'x-csrf-token': token } : {},
      failOnStatusCode: false
    })
    .catch(() => {});
}

/** Open `/agents/<id>` and wait for xterm to attach to window.__maw_xterm. */
export async function openAgentPage(page: Page, agentId: string): Promise<void> {
  await page.goto(`/agents/${agentId}`);
  await page.waitForFunction(
    () => Boolean((window as unknown as { __maw_xterm?: unknown }).__maw_xterm),
    { timeout: 20_000 }
  );
}
