/**
 * Live regression tests for cli-adapters/claude-code.jsonc against modern
 * Claude Code TUI output (verified against v2.1.126, May 2026).
 *
 * The original starter regexes (anchored on `>` for ready, `run|proceed with`
 * for tool prompts, `✓ Task complete` for done) silently never fired against
 * real claude output. This file exercises the live JSONC config so that any
 * future drift in claude's TUI surfaces as a failing test, not a quietly
 * dead notification path.
 *
 * Out of scope: the hook path (POST /api/internal/claude-hook) is the
 * primary tool-permission detector for claude-code agents whose worktree
 * has .claude/settings.local.json; these regexes are the fallback for
 * agents that don't, plus the only path for ready / task_done / error
 * (no hook equivalent).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { adapterConfigSchema } from './adapter.config.schema.js';
import { ConfigDrivenAdapter } from './ConfigDrivenAdapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adapterPath = resolve(__dirname, '../../../../../cli-adapters/claude-code.jsonc');

function newAdapter(): ConfigDrivenAdapter {
  const errors: ParseError[] = [];
  const raw = parseJsonc(readFileSync(adapterPath, 'utf8'), errors, {
    allowTrailingComma: true
  });
  if (errors.length > 0) throw new Error(`JSONC parse errors: ${JSON.stringify(errors)}`);
  return new ConfigDrivenAdapter(adapterConfigSchema.parse(raw));
}

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('cli-adapters/claude-code.jsonc — live regex regression', () => {
  describe('tool_permission_prompt — modern verbs', () => {
    it('matches Write phrasing: "Do you want to create <file>?"', () => {
      const a = newAdapter();
      const events = a.ingest(buf(' Do you want to create notes.txt?\n ❯ 1. Yes\n   2. Yes, allow all\n   3. No\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev).toBeDefined();
      expect(ev?.detail).toMatchObject({ action: 'create notes.txt' });
      expect(a.state()).toBe('WAITING_PROMPT');
    });

    it('matches Edit phrasing: "Do you want to make this edit to <file>?"', () => {
      const a = newAdapter();
      const events = a.ingest(buf(' Do you want to make this edit to /abs/path/file.ts?\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev).toBeDefined();
      expect(ev?.detail).toMatchObject({ action: 'make this edit to /abs/path/file.ts' });
    });

    it('still matches legacy "Do you want to run <tool>?"', () => {
      const a = newAdapter();
      const events = a.ingest(buf(' Do you want to run npm test?\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev?.detail).toMatchObject({ action: 'run npm test' });
    });

    it('still matches legacy "Do you want to proceed with <tool>?"', () => {
      const a = newAdapter();
      const events = a.ingest(buf(' Do you want to proceed with foo?\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev?.detail).toMatchObject({ action: 'proceed with foo' });
    });

    it('non-greedy: stops at the first `?` so it can\'t span past the prompt', () => {
      const a = newAdapter();
      const events = a.ingest(buf(' Do you want to create notes.txt? Some other text? More.\n'));
      const ev = events.find((e) => e.patternId === 'tool_permission_prompt');
      expect(ev?.detail).toMatchObject({ action: 'create notes.txt' });
    });

    it('caps action capture at 80 chars to avoid runaway matches', () => {
      const a = newAdapter();
      // 90-char action with no `?` inside — should not match.
      const longAction = 'x'.repeat(90);
      const events = a.ingest(buf(` Do you want to ${longAction}?\n`));
      expect(events.find((e) => e.patternId === 'tool_permission_prompt')).toBeUndefined();
    });

    it('strips ANSI before matching', () => {
      const a = newAdapter();
      // Real claude wraps the question in SGR sequences.
      const ansi = '[1m Do you want to create notes.txt?[0m\n';
      const events = a.ingest(buf(ansi));
      expect(events.find((e) => e.patternId === 'tool_permission_prompt')?.detail)
        .toMatchObject({ action: 'create notes.txt' });
    });
  });

  describe('plan_approval_prompt', () => {
    it('matches "Would you like to proceed?"', () => {
      const a = newAdapter();
      const events = a.ingest(buf('Plan summary…\n\nWould you like to proceed?\n❯ 1. Yes\n  2. No\n'));
      expect(events.find((e) => e.patternId === 'plan_approval_prompt')).toBeDefined();
      expect(a.state()).toBe('WAITING_PROMPT');
    });
  });

  describe('ready — footer signal', () => {
    it('fires when last non-empty line is `? for shortcuts`', () => {
      const a = newAdapter();
      a.ingest(buf('────\n❯  \n────\n  ? for shortcuts\n'));
      expect(a.state()).toBe('READY');
    });

    it('fires when footer carries effort indicator', () => {
      const a = newAdapter();
      a.ingest(
        buf(
          '────\n❯  \n────\n  ? for shortcuts                                                                                    ◉ xhigh · /effort\n'
        )
      );
      expect(a.state()).toBe('READY');
    });

    it('does NOT fire while working — footer is `esc to interrupt`', () => {
      const a = newAdapter();
      a.ingest(buf('✽ Hyperspacing… (7s · ↑ 89 tokens)\n────\n❯  \n────\n  esc to interrupt\n'));
      expect(a.state()).not.toBe('READY');
    });

    it('does NOT fire on the literal `❯  ` empty-prompt line — it is not the last line', () => {
      // The empty prompt line is always sandwiched between ──── rules with
      // a footer below; it is never the last non-empty line on its own.
      // This test pins that behavior so a regression that anchors `ready`
      // on `❯` (which fires mid-task too) gets caught.
      const a = newAdapter();
      a.ingest(buf('some output\n────\n❯  \n────\n'));
      // Last non-empty line is `────`, not `? for shortcuts` → no match.
      expect(a.state()).not.toBe('READY');
    });
  });

  describe('task_done — modern signal', () => {
    it('matches `✻ Cooked for 4s`', () => {
      const a = newAdapter();
      a.ingest(buf('● The directory contains only a .git folder.\n\n✻ Cooked for 4s\n'));
      expect(a.state()).toBe('IDLE');
    });

    it('matches `✻ Baked for 9s`', () => {
      const a = newAdapter();
      a.ingest(buf('● Tuesday, May 5, 2026.\n\n✻ Baked for 9s\n'));
      expect(a.state()).toBe('IDLE');
    });

    it('matches `✻ Sautéed for 3s` (non-ASCII verb)', () => {
      const a = newAdapter();
      a.ingest(buf('● Result.\n\n✻ Sautéed for 3s\n'));
      expect(a.state()).toBe('IDLE');
    });

    it('matches `✻ Cooked for 4m` (minutes)', () => {
      const a = newAdapter();
      a.ingest(buf('● Big task done.\n\n✻ Cooked for 4m\n'));
      expect(a.state()).toBe('IDLE');
    });

    it('does NOT match still-working `✽ Hyperspacing… (7s · ↑ 89 tokens)` (different glyph + no `for Ns`)', () => {
      const a = newAdapter();
      const events = a.ingest(
        buf('✽ Hyperspacing… (7s · ↑ 89 tokens)\n  ⎿  Tip: Use /feedback to help us improve!\n')
      );
      expect(events.find((e) => e.patternId === 'task_done')).toBeUndefined();
    });

    it('does NOT match prose containing `for 4s` without ✻ prefix', () => {
      const a = newAdapter();
      const events = a.ingest(buf('I waited for 4s before running the build.\n'));
      expect(events.find((e) => e.patternId === 'task_done')).toBeUndefined();
    });
  });

  describe('rate_limit', () => {
    it('matches case-insensitive `Rate Limit`', () => {
      const a = newAdapter();
      const events = a.ingest(buf('Error: Rate Limit hit, retrying in 30s\n'));
      const ev = events.find((e) => e.patternId === 'rate_limit');
      expect(ev).toBeDefined();
      expect(ev?.detail).toMatchObject({ message: 'Rate Limit' });
    });

    it('matches `quota exceeded`', () => {
      const a = newAdapter();
      const events = a.ingest(buf('Error: quota exceeded\n'));
      const ev = events.find((e) => e.patternId === 'rate_limit');
      expect(ev).toBeDefined();
    });
  });

  describe('promptAnswers wiring (matches modern 1/2/3 menu)', () => {
    it('exposes 1, 2, 3 → digit + Enter', () => {
      const a = newAdapter();
      expect(a.input.answerPrompt('1')).toEqual(['1', 'Enter']);
      expect(a.input.answerPrompt('2')).toEqual(['2', 'Enter']);
      expect(a.input.answerPrompt('3')).toEqual(['3', 'Enter']);
    });

    it('still exposes legacy yes / no / abort', () => {
      const a = newAdapter();
      expect(a.input.answerPrompt('yes')).toEqual(['y', 'Enter']);
      expect(a.input.answerPrompt('no')).toEqual(['n', 'Enter']);
      expect(a.input.answerPrompt('abort')).toEqual(['C-c']);
    });
  });

  describe('end-to-end turn shape', () => {
    it('user message → working → task_done → ready (mirrors a real turn)', () => {
      const a = newAdapter();
      // 1. Some streaming output — adapter assumes WORKING.
      a.ingest(buf('● The directory contains only a .git folder.\n'));
      expect(a.state()).toBe('WORKING');

      // 2. Claude prints its end-of-turn marker.
      a.ingest(buf('\n✻ Cooked for 4s\n'));
      expect(a.state()).toBe('IDLE');

      // 3. The footer settles into idle mode.
      a.ingest(buf('\n────\n❯  \n────\n  ? for shortcuts\n'));
      expect(a.state()).toBe('READY');
    });
  });
});
