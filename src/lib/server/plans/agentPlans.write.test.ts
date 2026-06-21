/**
 * Real-filesystem tests for `writeAgentPlanFile` — the spawn-time helper that
 * materializes a task's plan markdown into the worktree so the initial prompt
 * can reference it instead of inlining a (potentially large) plan.
 *
 * Deliberately NOT using the mocked-`node:fs/promises` harness in
 * `agentPlans.test.ts`: this exercises the real mkdir / writeFile / existsSync
 * path against a throwaway temp worktree so the file actually lands on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAgentPlanFile } from './agentPlans.js';

let wt: string;
beforeEach(async () => {
  wt = await mkdtemp(join(tmpdir(), 'maw-plan-test-'));
});
afterEach(async () => {
  await rm(wt, { recursive: true, force: true });
});

describe('writeAgentPlanFile', () => {
  it('writes docs/plans/<slug>.md and returns the worktree-relative path', async () => {
    const ref = await writeAgentPlanFile(wt, 'start-project', '# Plan\n\nbuild it');
    expect(ref).toBe('docs/plans/start-project.md');
    const onDisk = await readFile(join(wt, 'docs/plans/start-project.md'), 'utf8');
    // Trailing newline is ensured for clean diffs.
    expect(onDisk).toBe('# Plan\n\nbuild it\n');
  });

  it('does not double the trailing newline when the plan already ends in one', async () => {
    const ref = await writeAgentPlanFile(wt, 'p', 'already\n');
    expect(ref).toBe('docs/plans/p.md');
    expect(await readFile(join(wt, 'docs/plans/p.md'), 'utf8')).toBe('already\n');
  });

  it('returns null and never clobbers an existing plan file', async () => {
    await mkdir(join(wt, 'docs/plans'), { recursive: true });
    await writeFile(join(wt, 'docs/plans/dup.md'), 'ORIGINAL');
    const ref = await writeAgentPlanFile(wt, 'dup', 'NEW CONTENT');
    expect(ref).toBeNull();
    expect(await readFile(join(wt, 'docs/plans/dup.md'), 'utf8')).toBe('ORIGINAL');
  });

  it('honors a custom plansDirectory from .claude/settings.json', async () => {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(
      join(wt, '.claude/settings.json'),
      JSON.stringify({ plansDirectory: 'plans' })
    );
    const ref = await writeAgentPlanFile(wt, 'custom', 'body');
    expect(ref).toBe('plans/custom.md');
    expect(existsSync(join(wt, 'plans/custom.md'))).toBe(true);
  });

  it('returns null for an unsafe slug rather than writing outside the plans dir', async () => {
    // '' → filename '.md' fails the safe-filename regex (leading dot).
    expect(await writeAgentPlanFile(wt, '', 'body')).toBeNull();
    // A slash would escape the single-file convention.
    expect(await writeAgentPlanFile(wt, 'a/b', 'body')).toBeNull();
    expect(existsSync(join(wt, 'docs/plans'))).toBe(false);
  });
});
