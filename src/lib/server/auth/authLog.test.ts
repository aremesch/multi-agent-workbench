import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Mocks — queries.insertAuthEvent is a spy and `getConfig().authLogPath` is
// pointed at a per-test temp file. We re-import the module under test between
// tests so the `ensuredDir` cache doesn't leak across cases.
// -----------------------------------------------------------------------------

const insertAuthEventMock = vi.fn();

vi.mock('../db/queries.js', () => ({
  insertAuthEvent: (...args: unknown[]) => insertAuthEventMock(...args)
}));

let tempDir: string;
let authLogPath: string;

vi.mock('../config.js', () => ({
  getConfig: () => ({ authLogPath })
}));

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'maw-authlog-'));
  authLogPath = join(tempDir, 'auth.log');
  insertAuthEventMock.mockReset();
  vi.resetModules(); // reset the ensuredDir cache inside authLog.ts
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function importLogAuth(): Promise<typeof import('./authLog.js').logAuth> {
  const mod = await import('./authLog.js');
  return mod.logAuth;
}

describe('logAuth — dual write', () => {
  it('appends one line to the file AND inserts one DB row', async () => {
    const logAuth = await importLogAuth();
    logAuth('login_ok', {
      userId: 'u1',
      username: 'alice',
      ip: '10.0.0.1',
      userAgent: 'Chrome'
    });
    const line = readFileSync(authLogPath, 'utf8');
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z login_ok /);
    expect(line).toContain('user=alice');
    expect(line).toContain('ip=10.0.0.1');
    expect(line).toContain('ua="Chrome"');
    expect(line.endsWith('\n')).toBe(true);

    expect(insertAuthEventMock).toHaveBeenCalledTimes(1);
    const row = insertAuthEventMock.mock.calls[0][0];
    expect(row).toMatchObject({
      event: 'login_ok',
      user_id: 'u1',
      username: 'alice',
      ip: '10.0.0.1',
      user_agent: 'Chrome'
    });
    expect(typeof row.ts).toBe('number');
  });

  it('emits dashes for missing username / userAgent so fail2ban parse stays stable', async () => {
    const logAuth = await importLogAuth();
    logAuth('ws_origin_reject', { ip: '192.168.1.5' });
    const line = readFileSync(authLogPath, 'utf8');
    expect(line).toContain('user=-');
    expect(line).toContain('ua="-"');
  });

  it('defaults user_id/username/user_agent/detail to null in the DB row', async () => {
    const logAuth = await importLogAuth();
    logAuth('rate_limited', { ip: '1.1.1.1' });
    const row = insertAuthEventMock.mock.calls[0][0];
    expect(row.user_id).toBeNull();
    expect(row.username).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.detail).toBeNull();
  });

  it('creates the log directory on first write if it does not exist', async () => {
    authLogPath = join(tempDir, 'nested', 'subdir', 'auth.log');
    const logAuth = await importLogAuth();
    logAuth('login_ok', { ip: '1.1.1.1' });
    expect(readFileSync(authLogPath, 'utf8')).toContain('login_ok');
  });
});

describe('logAuth — sanitization', () => {
  it('strips CR/LF/TAB from user-controlled fields (log-injection guard)', async () => {
    const logAuth = await importLogAuth();
    logAuth('login_fail', {
      username: 'evil\nuser=admin\r\ttabhere',
      ip: '127.0.0.1',
      userAgent: 'nasty\nheader'
    });
    const line = readFileSync(authLogPath, 'utf8');
    // Exactly one terminating newline; no embedded CR/LF/TAB in the middle.
    const body = line.slice(0, -1);
    expect(body).not.toMatch(/[\r\n\t]/);
    expect(body.endsWith('\n')).toBe(false);
    expect(line.endsWith('\n')).toBe(true);
    // The injection attempt must land as a space-separated string in the
    // user field, not as a new log entry.
    expect(line).toMatch(/user=evil user=admin  tabhere/);
  });

  it('caps each sanitized field at 256 chars', async () => {
    const logAuth = await importLogAuth();
    const huge = 'a'.repeat(1024);
    logAuth('login_fail', { username: huge, ip: '1.1.1.1', userAgent: huge });
    const line = readFileSync(authLogPath, 'utf8');
    // user= field starts after 'login_fail '. Grab the segment between
    // 'user=' and ' ip=' and assert length ≤ 256.
    const m = line.match(/user=(.*?) ip=/);
    expect(m?.[1]?.length).toBe(256);
    const m2 = line.match(/ua="(.*?)"/);
    expect(m2?.[1]?.length).toBe(256);
  });
});

describe('logAuth — never throws', () => {
  it('swallows file-write failures silently', async () => {
    // Point the log path at an unwritable location (a directory used as a
    // file). appendFileSync would normally throw; logAuth catches it.
    authLogPath = tempDir; // it's a directory, so append will fail
    const logAuth = await importLogAuth();
    expect(() =>
      logAuth('login_fail', { ip: '1.1.1.1' })
    ).not.toThrow();
    // DB insert still runs — the two try/catch blocks are independent.
    expect(insertAuthEventMock).toHaveBeenCalledTimes(1);
  });

  it('swallows DB insert failures silently', async () => {
    insertAuthEventMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const logAuth = await importLogAuth();
    expect(() =>
      logAuth('login_ok', { userId: 'u', ip: '1.1.1.1' })
    ).not.toThrow();
    // File write still produced a line — independence again.
    expect(readFileSync(authLogPath, 'utf8')).toContain('login_ok');
  });
});
