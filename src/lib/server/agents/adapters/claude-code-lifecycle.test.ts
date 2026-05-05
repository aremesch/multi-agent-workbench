/**
 * claude-code adapter lifecycle tests.
 *
 * Loads the real `cli-adapters/claude-code.jsonc` (the same file shipped to
 * production) and walks the ConfigDrivenAdapter through the lifecycle the
 * user sees in the dashboard:
 *
 *   BOOTING → WORKING → WAITING_PROMPT → IDLE → READY
 *
 * If a future PR breaks one of the claude-code regexes (e.g. tightens
 * `Would you like to proceed?` or drops a `choices` field), this suite
 * fails loudly. The generic ConfigDrivenAdapter.test.ts uses synthetic
 * configs and won't catch claude-code-specific regressions.
 *
 * The patterns were tuned against captured panes from Claude Code v2.1.126
 * (May 2026). Out of scope: the hook path (POST /api/internal/claude-hook)
 * is the primary tool-permission detector for claude-code agents whose
 * worktree has .claude/settings.local.json; these regexes are the
 * fallback for agents that don't, plus the only path for
 * ready / task_done / error (no hook equivalent).
 *
 * No real `claude` subprocess: tests/integration/claude-code-live.test.ts
 * covers that path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadClaudeCodeAdapter } from '../../../../../tests/unit/helpers/claudeCodeAdapter.js';

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('claude-code adapter — real cli-adapters/claude-code.jsonc', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('config sanity', () => {
    it('parses the production JSONC without errors', () => {
      expect(() => loadClaudeCodeAdapter()).not.toThrow();
    });

    it('exposes claude-code identity', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.kind).toBe('claude-code');
      expect(a.displayName).toBe('Claude Code');
    });

    it('needsCliSessionId is true (spawn args reference {{agent.cliSessionId}})', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.needsCliSessionId).toBe(true);
    });
  });

  describe('mobileQuickKeys carry exact VT220 escape sequences', () => {
    // The xterm.js side forwards these bytes verbatim through the WS
    // `send_keys` channel → AgentRuntime.enqueueRawKeys → tmux send-keys -l.
    // A typo here silently breaks arrow-key navigation in the touch UI.
    it('up = ESC[A', () => {
      const a = loadClaudeCodeAdapter();
      const up = a.mobileQuickKeys.find((k) => k.id === 'up');
      expect(up?.keys).toBe('[A');
    });

    it('down = ESC[B', () => {
      const a = loadClaudeCodeAdapter();
      const down = a.mobileQuickKeys.find((k) => k.id === 'down');
      expect(down?.keys).toBe('[B');
    });

    it('shift-tab = ESC[Z', () => {
      const a = loadClaudeCodeAdapter();
      const sht = a.mobileQuickKeys.find((k) => k.id === 'shift-tab');
      expect(sht?.keys).toBe('[Z');
    });

    it('esc = bare ESC', () => {
      const a = loadClaudeCodeAdapter();
      const esc = a.mobileQuickKeys.find((k) => k.id === 'esc');
      expect(esc?.keys).toBe('');
    });
  });

  describe('input.answerPrompt for documented choices', () => {
    it('"1" → ["1","Enter"] (modern Yes)', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.input.answerPrompt('1')).toEqual(['1', 'Enter']);
    });

    it('"2" → ["2","Enter"] (modern "Yes, allow all")', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.input.answerPrompt('2')).toEqual(['2', 'Enter']);
    });

    it('"3" → ["3","Enter"] (modern No — added with v2.1.x menu)', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.input.answerPrompt('3')).toEqual(['3', 'Enter']);
    });

    it('"yes" → ["y","Enter"] (legacy tool-permission accept)', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.input.answerPrompt('yes')).toEqual(['y', 'Enter']);
    });

    it('"no" → ["n","Enter"] (legacy tool-permission decline)', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.input.answerPrompt('no')).toEqual(['n', 'Enter']);
    });

    it('"abort" → ["C-c"] (no Enter — important!)', () => {
      const a = loadClaudeCodeAdapter();
      // C-c alone aborts the prompt. If a stray Enter sneaks in, claude
      // would treat it as "submit empty input" after the SIGINT and
      // potentially crash on the next prompt loop. Lock the exact shape.
      expect(a.input.answerPrompt('abort')).toEqual(['C-c']);
    });

    it('unknown choice falls back to [<choice>,"Enter"]', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.input.answerPrompt('foobar')).toEqual(['foobar', 'Enter']);
    });

    it('numeric choice 1 (number) resolves the same as string "1"', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.input.answerPrompt(1)).toEqual(['1', 'Enter']);
    });
  });

  describe('lifecycle: BOOTING → WORKING → IDLE → READY', () => {
    it('starts in BOOTING', () => {
      const a = loadClaudeCodeAdapter();
      expect(a.state()).toBe('BOOTING');
    });

    it('first non-pattern output flips BOOTING → WORKING (heuristic)', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('Welcome to Claude Code.\n'));
      expect(a.state()).toBe('WORKING');
    });

    it('the idle footer line `? for shortcuts` fires `ready` and reaches READY', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('Welcome to Claude Code.\n'));
      const events = a.ingest(buf('────\n❯  \n────\n  ? for shortcuts\n'));
      expect(events.map((e) => e.kind)).toContain('ready');
      expect(a.state()).toBe('READY');
    });

    it('does NOT reach READY while working — footer is `esc to interrupt`', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('✽ Hyperspacing… (7s · ↑ 89 tokens)\n────\n❯  \n────\n  esc to interrupt\n'));
      expect(a.state()).not.toBe('READY');
    });

    it('does NOT fire ready on the literal `❯  ` empty-prompt line by itself', () => {
      // The empty prompt line is always sandwiched between ──── rules with
      // a footer below; it is never the last non-empty line on its own.
      // This pins the behavior so a regression that anchors `ready` on
      // `❯` (which would fire mid-task too) gets caught.
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('some output\n────\n❯  \n────\n'));
      expect(a.state()).not.toBe('READY');
    });

    it('isIdleWaiting() returns false in READY (state-machine quirk)', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('Welcome\n────\n❯  \n────\n  ? for shortcuts\n'));
      expect(a.state()).toBe('READY');
      // ConfigDrivenAdapter.isIdleWaiting() short-circuits to `false` for
      // any state outside of WAITING_PROMPT/WORKING/IDLE. READY is treated
      // as a transient "just printed prompt" state where the next byte
      // could be more output — so it never reports idle. This documents
      // the actual semantics so a future change doesn't silently flip them.
      expect(a.isIdleWaiting()).toBe(false);
    });

    it('isIdleWaiting() returns false when output keeps flowing past the prompt', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('Welcome\n────\n❯  \n────\n  ? for shortcuts\n'));
      a.ingest(buf('working on it...'));
      expect(a.isIdleWaiting()).toBe(false);
    });
  });

  describe('plan-approval prompt detection', () => {
    const planText =
      '⏺ Here is my plan:\n' +
      '  1. Yes\n' +
      '  2. No, with feedback\n' +
      'Would you like to proceed?';

    it('emits a single prompt_detected event with the right shape', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('Welcome\n'));
      const events = a.ingest(buf(planText));
      const prompts = events.filter((e) => e.kind === 'prompt_detected');
      expect(prompts).toHaveLength(1);
      const ev = prompts[0]!;
      expect(ev.patternId).toBe('plan_approval_prompt');
      expect(ev.choices).toEqual(['1', '2', 'abort']);
      expect(ev.raw).toBe('Would you like to proceed?');
    });

    it('flips state to WAITING_PROMPT and isIdleWaiting() becomes true', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf(planText));
      expect(a.state()).toBe('WAITING_PROMPT');
      expect(a.isIdleWaiting()).toBe(true);
    });

    it('is deduped while the matched text is still in the tail', () => {
      const a = loadClaudeCodeAdapter();
      const first = a.ingest(buf(planText));
      expect(first.filter((e) => e.kind === 'prompt_detected')).toHaveLength(1);
      // A small unrelated chunk that does NOT push the prompt out.
      const second = a.ingest(buf(' (waiting...)'));
      expect(second.filter((e) => e.kind === 'prompt_detected')).toHaveLength(0);
    });

    it('re-fires after the matched text scrolls out of the tail (8KB)', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf(planText));
      // Push enough bytes to evict (tail is 8KB, scrub 9KB to be safe).
      a.ingest(buf('x'.repeat(9 * 1024)));
      const second = a.ingest(buf(planText));
      expect(second.filter((e) => e.kind === 'prompt_detected')).toHaveLength(1);
    });
  });

  describe('tool-permission prompt — v2.1.x verbs', () => {
    it('matches Write phrasing: "Do you want to create <file>?"', () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(
        buf(' Do you want to create notes.txt?\n ❯ 1. Yes\n   2. Yes, allow all\n   3. No\n')
      );
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev).toBeDefined();
      expect(ev?.detail).toMatchObject({ action: 'create notes.txt' });
      expect(ev?.choices).toEqual(['1', '2', '3', 'abort']);
      expect(a.state()).toBe('WAITING_PROMPT');
    });

    it('matches Edit phrasing: "Do you want to make this edit to <file>?"', () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(buf(' Do you want to make this edit to /abs/path/file.ts?\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev?.detail).toMatchObject({ action: 'make this edit to /abs/path/file.ts' });
    });

    it('still matches legacy "Do you want to run <tool>?"', () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(buf(' Do you want to run npm test?\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev?.detail).toMatchObject({ action: 'run npm test' });
    });

    it('still matches legacy "Do you want to proceed with <tool>?"', () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(buf(' Do you want to proceed with foo?\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev?.detail).toMatchObject({ action: 'proceed with foo' });
    });

    it("non-greedy: stops at the first `?` so it can't span past the prompt", () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(buf(' Do you want to create notes.txt? Some other text? More.\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev?.detail).toMatchObject({ action: 'create notes.txt' });
    });

    it('caps action capture at 80 chars to avoid runaway matches', () => {
      const a = loadClaudeCodeAdapter();
      const longAction = 'x'.repeat(90);
      const events = a.ingest(buf(` Do you want to ${longAction}?\n`));
      expect(events.find((e) => e.patternId === 'tool_permission_prompt')).toBeUndefined();
    });

    it('strips ANSI before matching', () => {
      const a = loadClaudeCodeAdapter();
      // Real claude wraps the question in SGR sequences.
      const ansi = '[1m Do you want to create notes.txt?[0m\n';
      const events = a.ingest(buf(ansi));
      expect(events.find((e) => e.patternId === 'tool_permission_prompt')?.detail).toMatchObject({
        action: 'create notes.txt'
      });
    });
  });

  describe('task_done — modern signal', () => {
    it('matches `✻ Cooked for 4s`', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('● The directory contains only a .git folder.\n\n✻ Cooked for 4s\n'));
      expect(a.state()).toBe('IDLE');
    });

    it('matches `✻ Baked for 9s`', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('● Tuesday, May 5, 2026.\n\n✻ Baked for 9s\n'));
      expect(a.state()).toBe('IDLE');
    });

    it('matches `✻ Sautéed for 3s` (non-ASCII verb)', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('● Result.\n\n✻ Sautéed for 3s\n'));
      expect(a.state()).toBe('IDLE');
    });

    it('matches `✻ Cooked for 4m` (minutes)', () => {
      const a = loadClaudeCodeAdapter();
      a.ingest(buf('● Big task done.\n\n✻ Cooked for 4m\n'));
      expect(a.state()).toBe('IDLE');
    });

    it('does NOT match still-working `✽ Hyperspacing… (7s · ↑ 89 tokens)` (different glyph + no `for Ns`)', () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(
        buf('✽ Hyperspacing… (7s · ↑ 89 tokens)\n  ⎿  Tip: Use /feedback to help us improve!\n')
      );
      expect(events.find((e) => e.patternId === 'task_done')).toBeUndefined();
    });

    it('does NOT match prose containing `for 4s` without ✻ prefix', () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(buf('I waited for 4s before running the build.\n'));
      expect(events.find((e) => e.patternId === 'task_done')).toBeUndefined();
    });

    it('is deduped while the matched text is still in the tail', () => {
      const a = loadClaudeCodeAdapter();
      const first = a.ingest(buf('✻ Cooked for 4s\n'));
      expect(first.filter((e) => e.kind === 'task_done')).toHaveLength(1);
      const second = a.ingest(buf(' (status)'));
      expect(second.filter((e) => e.kind === 'task_done')).toHaveLength(0);
    });
  });

  describe('rate_limit error', () => {
    it('emits an error event but does NOT change state', () => {
      const a = loadClaudeCodeAdapter();
      // Put the adapter in WORKING first.
      a.ingest(buf('thinking...'));
      expect(a.state()).toBe('WORKING');
      const events = a.ingest(buf('Encountered rate-limit'));
      const err = events.find((e) => e.kind === 'error');
      expect(err).toBeDefined();
      expect(err!.patternId).toBe('rate_limit');
      // detail should carry the named `message` group
      expect(err!.detail?.message).toMatch(/rate.limit/i);
      // State machine: error doesn't advance state.
      expect(a.state()).toBe('WORKING');
    });

    it('matches "quota exceeded" alternate via the alternation', () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(buf('error: quota exceeded for this org'));
      const err = events.find((e) => e.kind === 'error');
      expect(err).toBeDefined();
    });

    it('is case-insensitive (the `i` flag)', () => {
      const a = loadClaudeCodeAdapter();
      const events = a.ingest(buf('RATE LIMIT hit'));
      const err = events.find((e) => e.kind === 'error');
      expect(err).toBeDefined();
    });
  });

  describe('full lifecycle integration (synthetic)', () => {
    it('walks BOOTING → WORKING → WAITING_PROMPT → IDLE → READY in order', () => {
      const a = loadClaudeCodeAdapter();

      // 0. Spawn — adapter is fresh.
      expect(a.state()).toBe('BOOTING');

      // 1. Boot output without a pattern → WORKING heuristic kicks in.
      a.ingest(buf('Welcome to Claude Code 4.5\n'));
      expect(a.state()).toBe('WORKING');

      // 2. User types a task; claude streams response. Still WORKING
      //    (no pattern shifts state).
      a.ingest(buf('write 10 random lines\n'));
      a.ingest(buf('Sure, I will create them now.\n'));
      expect(a.state()).toBe('WORKING');
      expect(a.isIdleWaiting()).toBe(false);

      // 3. Tool-permission prompt fires → WAITING_PROMPT.
      const events = a.ingest(buf(' Do you want to create notes.txt?\n'));
      const prompt = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(prompt).toBeDefined();
      expect(prompt!.detail?.action).toBe('create notes.txt');
      expect(a.state()).toBe('WAITING_PROMPT');
      expect(a.isIdleWaiting()).toBe(true);

      // 4. User answers (e.g. "3" — declines). The prompt text scrolls
      //    out as claude continues; we simulate that with a big chunk
      //    plus the end-of-turn marker.
      a.ingest(buf('OK, skipping the file write.\n'.padEnd(9 * 1024, ' ')));
      const doneEvents = a.ingest(buf('✻ Cooked for 4s\n'));
      const done = doneEvents.find((e) => e.kind === 'task_done');
      expect(done).toBeDefined();
      expect(a.state()).toBe('IDLE');

      // 5. Footer settles into idle mode → READY.
      a.ingest(buf('\n────\n❯  \n────\n  ? for shortcuts\n'));
      expect(a.state()).toBe('READY');
    });
  });
});
