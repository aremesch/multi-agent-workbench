/**
 * Regression for Bug #2 in docs/plans/v0.2-terminal-output-alignment.md:
 * Claude Code agents (scrollbackMode: 'visible', historySource: claude-jsonl)
 * used to render misaligned on reopen — the TUI at the top of the viewport,
 * the cursor dangling below blank rows. The fix: trim trailing blanks from
 * the capture + append a CUP escape pinned to tmux's real cursor.
 *
 * Skips automatically if the server doesn't have `claude` registered as a
 * CLI kind (the role-creation probe returns 400 in that case).
 */
import { expect, test } from '@playwright/test';
import {
  cliKindAvailable,
  createProject,
  createRepo,
  createRole,
  deleteAgent,
  openAgentPage,
  spawnAgent
} from './helpers/fixtures';
import { readTerminal, waitForTerminal } from './helpers/terminal';

test.describe('claude-code reopen alignment', () => {
  test('cursor stays aligned with TUI after close + reopen', async ({ page }) => {
    test.skip(!(await cliKindAvailable(page, 'claude-code')), 'claude-code adapter not registered');

    const project = await createProject(page);
    const repo = await createRepo(page, project.id);
    const role = await createRole(page, 'claude-code');

    const agent = await spawnAgent(page, {
      role_id: role.id,
      repo_id: repo.id,
      task_body: 'just say hi and stop'
    });
    try {
      await openAgentPage(page, agent.id);

      // First render: wait for *any* non-blank content — Claude paints its
      // splash frame within a few seconds.
      const first = await waitForTerminal(
        page,
        (s) => s.lines.some((l) => l.trim().length > 0),
        { label: 'claude first paint', timeoutMs: 30_000 }
      );
      const firstLastNonEmpty = lastNonEmptyRow(first.lines);
      expect(firstLastNonEmpty, 'first paint has content').toBeGreaterThanOrEqual(0);
      // Claude's TUI stacks a border + input box + status bar below the
      // rendered content; the cursor parks inside the input. ±6 catches the
      // regression we're guarding (pre-fix drift was 10+ rows dangling below
      // blank space) without being brittle to Claude's natural layout.
      const firstDrift = Math.abs(first.cursorY - firstLastNonEmpty);
      expect(firstDrift, 'first paint cursor near rendered TUI').toBeLessThanOrEqual(6);

      // Simulate close + reopen: go away, come back. AgentTerminalPanel's
      // onDestroy unsubscribes, so this re-drives the exact subscribe path
      // that used to misalign.
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await openAgentPage(page, agent.id);

      const reopen = await waitForTerminal(
        page,
        (s) => s.lines.some((l) => l.trim().length > 0),
        { label: 'claude reopen paint', timeoutMs: 30_000 }
      );
      const reopenLastNonEmpty = lastNonEmptyRow(reopen.lines);
      expect(reopenLastNonEmpty, 'reopen has content').toBeGreaterThanOrEqual(0);

      // The real regression: reopen drifts FURTHER from content than the
      // first-paint baseline — pre-fix the cursor dangled 10+ rows below
      // blank space. Compare against the baseline we just captured, not
      // a hardcoded offset, so Claude's footer layout changes don't flake us.
      let reopenDrift = Math.abs(reopen.cursorY - reopenLastNonEmpty);
      if (Math.abs(reopenDrift - firstDrift) > 2) {
        await page.waitForTimeout(1000);
        const settled = await readTerminal(page);
        reopenDrift = Math.abs(settled.cursorY - lastNonEmptyRow(settled.lines));
      }
      expect(
        Math.abs(reopenDrift - firstDrift),
        'reopen cursor drift matches first-paint baseline'
      ).toBeLessThanOrEqual(2);
    } finally {
      await deleteAgent(page, agent.id);
    }
  });
});

function lastNonEmptyRow(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim().length > 0) return i;
  }
  return -1;
}
