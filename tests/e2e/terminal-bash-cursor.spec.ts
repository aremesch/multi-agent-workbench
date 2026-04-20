/**
 * Regression for Bug #1 in docs/plans/v0.2-terminal-output-alignment.md:
 * shell agents (scrollbackMode: 'history') used to land the xterm cursor
 * two rows below the bash prompt because capture-pane emits trailing blank
 * grid rows and the dedup heuristic can't collapse below k=2.
 *
 * This spec spawns a real shell agent through the form-action pipeline,
 * opens its terminal page, and asserts that the cursor sits on the same row
 * as the rendered bash prompt — no blank lines in between.
 */
import { expect, test } from '@playwright/test';
import {
  createProject,
  createRepo,
  createRole,
  deleteAgent,
  openAgentPage,
  spawnAgent
} from './helpers/fixtures';
import { waitForTerminal } from './helpers/terminal';

test.describe('shell adapter cursor alignment', () => {
  test('cursor lands on the bash prompt row, no trailing blanks', async ({ page }) => {
    const project = await createProject(page);
    const repo = await createRepo(page, project.id);
    const role = await createRole(page, 'shell');

    const agent = await spawnAgent(page, { role_id: role.id, repo_id: repo.id });
    try {
      await openAgentPage(page, agent.id);

      // The bash prompt in the smoke adapter contains a `$` glyph; wait for
      // the snapshot to arrive (post-fix it should land the cursor on the
      // prompt line, pre-fix it would be 2 rows lower).
      const snap = await waitForTerminal(
        page,
        (s) => s.lines.some((l) => /\$\s*$/.test(l)),
        { label: 'bash prompt visible' }
      );

      // Find the row that ends with the prompt glyph.
      const promptRow = snap.lines.findIndex((l) => /\$\s*$/.test(l));
      expect(promptRow, 'bash prompt row in viewport').toBeGreaterThanOrEqual(0);

      // The cursor must be on the prompt row (the exact bug: it used to be
      // promptRow + 2). cursorY is relative to viewportY, so same frame of
      // reference as the `lines` array we just scanned.
      expect(snap.cursorY, 'cursor Y on prompt row').toBe(promptRow);

      // Every row below the prompt must be empty — no stray blanks pushed
      // into the grid, and nothing that would visually detach the cursor.
      for (let i = promptRow + 1; i < snap.lines.length; i++) {
        expect(snap.lines[i], `row ${i} below prompt is empty`).toBe('');
      }
    } finally {
      await deleteAgent(page, agent.id);
    }
  });
});
