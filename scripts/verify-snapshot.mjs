/**
 * Server-side verification for the terminal snapshot fixes
 * (docs/plans/v0.2-terminal-output-alignment.md).
 *
 * Spawns a shell agent via the real form-action pipeline, subscribes over
 * the live /ws channel, captures the first `scrollback` message, and asserts:
 *
 *   1. The decoded body ends with a CSI CUP escape (`\x1b[<y>;<x>H`) —
 *      evidence that `Tmux.cursorPosition` ran and the hub appended it.
 *   2. The body has no trailing blank lines before the CUP escape — the
 *      `rstripVisuallyEmptyLines` pass did its job.
 *   3. The CUP coordinates place the cursor on the bash prompt row.
 *
 * Cleans up the agent on exit. No Playwright / browser required.
 *
 * Usage:
 *   MAW_E2E_URL=http://emaw:3000 MAW_E2E_USERNAME=ar MAW_E2E_PASSWORD='...' \
 *     node scripts/verify-snapshot.mjs
 */

import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MAW_E2E_URL ?? 'http://emaw:3000';
const USERNAME = process.env.MAW_E2E_USERNAME;
const PASSWORD = process.env.MAW_E2E_PASSWORD;
if (!USERNAME || !PASSWORD) {
  console.error('Set MAW_E2E_USERNAME and MAW_E2E_PASSWORD');
  process.exit(2);
}

const jar = new Map();
function putSetCookie(header) {
  if (!header) return;
  const parts = Array.isArray(header) ? header : [header];
  for (const p of parts) {
    const first = p.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar.set(first.slice(0, eq), first.slice(eq + 1));
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (jar.size) headers.set('cookie', cookieHeader());
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get('set-cookie');
  putSetCookie(sc);
  return res;
}

async function login() {
  // Seed cookies (maw_csrf).
  await req('/login');
  const form = new URLSearchParams({ username: USERNAME, password: PASSWORD });
  const res = await req('/login?/login', {
    method: 'POST',
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }
  });
  if (res.status !== 303 && res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  if (!jar.has('maw_session')) throw new Error('login: no maw_session cookie returned');
}

async function postJson(path, body) {
  const headers = {
    'content-type': 'application/json',
    origin: BASE,
    'x-csrf-token': jar.get('maw_csrf') ?? ''
  };
  const res = await req(path, { method: 'POST', body: JSON.stringify(body), headers });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createScaffold() {
  const project = await postJson('/api/projects', { name: `verify-${Date.now()}`, default_branch: 'main' });
  const path = mkdtempSync(join(tmpdir(), 'maw-verify-'));
  const repo = await postJson('/api/repos', { project_id: project.id, path, origin_url: null });
  const role = await postJson('/api/roles', { name: `verify-shell-${Date.now()}`, cli_kind: 'shell', system_prompt: '' });
  return { project, repo, role };
}

async function spawnAgent(role_id, repo_id) {
  const form = new URLSearchParams({ role_id, repo_id, task_title: '', task_body: '' });
  const res = await req('/agents/new', {
    method: 'POST',
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }
  });
  if (res.status === 303) {
    const loc = res.headers.get('location') ?? '';
    const m = /\/agents\/([^/?#]+)/.exec(loc);
    if (!m) throw new Error(`spawn: no id in Location ${loc}`);
    return m[1];
  }
  if (res.status === 200) {
    const body = await res.json();
    if (body?.type === 'redirect' && typeof body.location === 'string') {
      const m = /\/agents\/([^/?#]+)/.exec(body.location);
      if (m) return m[1];
    }
  }
  throw new Error(`spawn unexpected ${res.status}: ${await res.text()}`);
}

async function deleteAgent(id) {
  await req(`/api/agents/${id}?removeWorktree=1`, {
    method: 'DELETE',
    headers: { 'x-csrf-token': jar.get('maw_csrf') ?? '' }
  }).catch(() => {});
}

function wsUrl() {
  const u = new URL(BASE);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

async function captureScrollback(agentId, cols = 120, rows = 32) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(), { headers: { cookie: cookieHeader() } });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('scrollback timed out'));
    }, 15_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', clientVersion: 1 }));
      ws.send(JSON.stringify({ type: 'subscribe_agent', agentId, cols, rows }));
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'scrollback' && msg.agentId === agentId) {
        clearTimeout(timer);
        const chunk = msg.chunks[0];
        const body = Buffer.from(chunk.b64, 'base64').toString('binary');
        ws.close();
        resolve(body);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`ws error: ${msg.code} ${msg.message}`));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function analyze(body) {
  // Strip the trailing CSI CUP (\x1b[<y>;<x>H) if present; capture its coords.
  const cupRe = /\x1b\[(\d+);(\d+)H$/;
  const m = body.match(cupRe);
  const cup = m ? { y: Number(m[1]), x: Number(m[2]) } : null;
  const withoutCup = cup ? body.slice(0, body.length - m[0].length) : body;

  // Normalize CRLF for analysis and check the last chunk for trailing blanks.
  const lines = withoutCup.split(/\r\n|\n/);
  let trailingBlanks = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const stripped = lines[i].replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (stripped === '') trailingBlanks++;
    else break;
  }
  // Count a single final "" that's an artefact of a trailing \n as harmless.
  const hasTrailingNewline = body.endsWith('\n') || body.endsWith('\r\n');
  const excessBlanks = Math.max(0, trailingBlanks - (hasTrailingNewline ? 1 : 0));

  return { cup, trailingBlanks, excessBlanks, lastContentLine: lastNonBlank(lines) };
}

function lastNonBlank(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const clean = (lines[i] ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (clean.length > 0) return { idx: i, text: clean };
  }
  return { idx: -1, text: '' };
}

async function main() {
  console.log(`[verify] authenticating @ ${BASE}`);
  await login();

  console.log('[verify] creating project/repo/role');
  const { role, repo } = await createScaffold();

  console.log('[verify] spawning shell agent');
  const agentId = await spawnAgent(role.id, repo.id);
  console.log(`[verify]   agent id = ${agentId}`);

  let failed = false;
  try {
    // Give bash a moment to render its prompt so capture-pane has something.
    await new Promise((r) => setTimeout(r, 1500));

    const body = await captureScrollback(agentId);
    const analysis = analyze(body);
    console.log('[verify] snapshot analysis:');
    console.log(`  bytes=${body.length}`);
    console.log(`  last content line (idx=${analysis.lastContentLine.idx}): ${JSON.stringify(analysis.lastContentLine.text)}`);
    console.log(`  trailing blanks=${analysis.trailingBlanks} (excess over \\n allowance=${analysis.excessBlanks})`);
    console.log(`  CUP escape=${JSON.stringify(analysis.cup)}`);

    const assertions = [
      ['CUP escape appended at end of snapshot', analysis.cup !== null],
      ['no excess trailing blank lines', analysis.excessBlanks === 0],
      ['last content line looks like a bash prompt', /[\$#>]\s*$/.test(analysis.lastContentLine.text)],
      ['CUP y matches bash prompt row (1-indexed)', analysis.cup ? analysis.cup.y === analysis.lastContentLine.idx + 1 : false]
    ];

    for (const [name, ok] of assertions) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
      if (!ok) failed = true;
    }
  } finally {
    console.log('[verify] cleaning up agent');
    await deleteAgent(agentId);
  }

  if (failed) {
    console.error('[verify] FAILURES above — fix not live.');
    process.exit(1);
  }
  console.log('[verify] all assertions passed.');
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
