/**
 * Focused unit tests for `composeBodyWithPlan`, the pure helper that combines
 * the task body and an optional plan markdown into the single initial-prompt
 * blob delivered to a cli-arg adapter at spawn time.
 *
 * The validator integration (Plan-aware `validateSpawnInputs`) is exercised
 * end-to-end by the queue API + Scheduler tests; this file pins the helper's
 * contract on its own so the composition can be refactored safely.
 */

import { describe, it, expect } from 'vitest';
import { composeBodyWithPlan } from './spawnFromInputs.js';

describe('composeBodyWithPlan', () => {
  it('returns the body unchanged when plan_md is null', () => {
    expect(composeBodyWithPlan('do the thing', null)).toBe('do the thing');
  });

  it('returns the body unchanged when plan_md is whitespace-only', () => {
    expect(composeBodyWithPlan('do the thing', '   \n  ')).toBe('do the thing');
  });

  it('appends a plan section after a non-empty body', () => {
    const out = composeBodyWithPlan('do the thing', 'step 1\nstep 2');
    expect(out).toBe('do the thing\n\n## Plan\n\nstep 1\nstep 2');
  });

  it('returns just the plan section when the body is empty', () => {
    expect(composeBodyWithPlan('', 'lonely plan')).toBe('## Plan\n\nlonely plan');
  });

  it('treats a whitespace-only body as empty and skips the leading blank line', () => {
    // trimEnd of '   ' collapses to '' so we fall into the empty-body branch
    // and emit `## Plan\n\n...` without leading whitespace.
    expect(composeBodyWithPlan('   ', 'p')).toBe('## Plan\n\np');
  });

  it('trims a trailing newline on the body before appending the plan', () => {
    const out = composeBodyWithPlan('body\n\n', 'plan');
    expect(out).toBe('body\n\n## Plan\n\nplan');
  });

  it('trims both ends of the plan markdown', () => {
    const out = composeBodyWithPlan('body', '\n\n  plan body  \n\n');
    expect(out).toBe('body\n\n## Plan\n\nplan body');
  });
});
