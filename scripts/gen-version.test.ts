import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mocks before any imports that might trigger module resolution.
const execSyncMock = vi.fn<(cmd: string, opts?: unknown) => string>();
vi.mock('node:child_process', () => ({ execSync: execSyncMock }));

const readFileSyncMock = vi.fn<(path: string, enc?: string) => string>(
  () => '{"version":"0.1.0"}'
);
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }));

// Dynamic import so the mocks above are definitely in place first.
const { generateVersionInfo } = await import('./gen-version.mjs');

beforeEach(() => {
  execSyncMock.mockReset();
  readFileSyncMock.mockReset();
  readFileSyncMock.mockReturnValue('{"version":"0.1.0"}');
});

// ── version: four git describe cases ──────────────────────────────────

describe('version — no tags (bare SHA)', () => {
  it('prefixes pkg.version + -dev. + sha', () => {
    execSyncMock
      .mockReturnValueOnce('abc1234\n') // git describe
      .mockReturnValueOnce('42\n') // git rev-list
      .mockReturnValueOnce('2026-01-01T00:00:00+00:00\n'); // git log

    const { version } = generateVersionInfo();
    expect(version).toBe('0.1.0-dev.abc1234');
  });
});

describe('version — tagged clean release', () => {
  it('strips leading v and returns bare semver', () => {
    execSyncMock
      .mockReturnValueOnce('v0.2.0\n')
      .mockReturnValueOnce('200\n')
      .mockReturnValueOnce('2026-03-15T12:00:00+01:00\n');

    const { version } = generateVersionInfo();
    expect(version).toBe('0.2.0');
  });
});

describe('version — tagged ahead (commits since tag)', () => {
  it('strips v prefix, keeps commits-since and sha suffix', () => {
    execSyncMock
      .mockReturnValueOnce('v0.2.0-3-gabc1234\n')
      .mockReturnValueOnce('203\n')
      .mockReturnValueOnce('2026-04-01T09:00:00+02:00\n');

    const { version } = generateVersionInfo();
    expect(version).toBe('0.2.0-3-gabc1234');
  });
});

describe('version — dirty working tree', () => {
  it('preserves -dirty suffix after stripping v', () => {
    execSyncMock
      .mockReturnValueOnce('v0.2.0-3-gabc1234-dirty\n')
      .mockReturnValueOnce('203\n')
      .mockReturnValueOnce('2026-04-01T09:00:00+02:00\n');

    const { version } = generateVersionInfo();
    expect(version).toBe('0.2.0-3-gabc1234-dirty');
  });
});

// ── build number + build date pass-through ────────────────────────────

describe('build number + build date', () => {
  it('returns trimmed git rev-list and git log outputs', () => {
    execSyncMock
      .mockReturnValueOnce('v0.2.0\n')
      .mockReturnValueOnce('147\n')
      .mockReturnValueOnce('2026-04-18T09:14:32+02:00\n');

    const { buildNumber, buildDate } = generateVersionInfo();
    expect(buildNumber).toBe('147');
    expect(buildDate).toBe('2026-04-18T09:14:32+02:00');
  });
});

// ── fallbacks when git is unavailable ─────────────────────────────────

describe('fallbacks (no git)', () => {
  it('falls back to pkg.json version, 0, and an ISO timestamp when git throws', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not a git repo');
    });

    const { version, buildNumber, buildDate } = generateVersionInfo();
    expect(version).toBe('0.1.0');
    expect(buildNumber).toBe('0');
    expect(() => new Date(buildDate).toISOString()).not.toThrow();
  });
});
