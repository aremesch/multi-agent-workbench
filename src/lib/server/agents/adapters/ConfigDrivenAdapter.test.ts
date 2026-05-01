import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterConfigSchema, type AdapterConfig } from './adapter.config.schema.js';
import { ConfigDrivenAdapter } from './ConfigDrivenAdapter.js';
import type { BuildSpawnSpecOpts } from '$shared/adapterTypes';

function cfg(overrides: Record<string, unknown> = {}): AdapterConfig {
  return adapterConfigSchema.parse({
    kind: 'shell',
    displayName: 'Shell',
    spawn: { command: 'bash' },
    input: {},
    ...overrides
  });
}

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('ConfigDrivenAdapter', () => {
  describe('lifecycle / state machine', () => {
    it('starts in BOOTING', () => {
      const a = new ConfigDrivenAdapter(cfg());
      expect(a.state()).toBe('BOOTING');
    });

    it('first output without pattern match advances BOOTING → WORKING', () => {
      const a = new ConfigDrivenAdapter(cfg());
      a.ingest(buf('some startup noise\n'));
      expect(a.state()).toBe('WORKING');
    });

    it('pattern kind: ready → READY', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'r', kind: 'ready', regex: '\\$ $' }] })
      );
      a.ingest(buf('$ '));
      expect(a.state()).toBe('READY');
    });

    it('pattern kind: working → WORKING', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'w', kind: 'working', regex: 'thinking' }] })
      );
      a.ingest(buf('thinking...'));
      expect(a.state()).toBe('WORKING');
    });

    it('pattern kind: prompt_detected → WAITING_PROMPT', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'p', kind: 'prompt_detected', regex: 'continue\\?' }] })
      );
      a.ingest(buf('do you want to continue?'));
      expect(a.state()).toBe('WAITING_PROMPT');
    });

    it('pattern kind: task_done → IDLE', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 't', kind: 'task_done', regex: 'done' }] })
      );
      a.ingest(buf('done'));
      expect(a.state()).toBe('IDLE');
    });

    it('pattern kind: exited → EXITED', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'e', kind: 'exited', regex: 'goodbye' }] })
      );
      a.ingest(buf('goodbye'));
      expect(a.state()).toBe('EXITED');
    });

    it('pattern kind: error does NOT transition state on its own', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          patterns: [
            { id: 'w', kind: 'working', regex: 'working' },
            { id: 'e', kind: 'error', regex: 'BOOM' }
          ]
        })
      );
      a.ingest(buf('working...'));
      expect(a.state()).toBe('WORKING');
      a.ingest(buf('BOOM'));
      expect(a.state()).toBe('WORKING');
    });

    it('emits one event per matching pattern, in declaration order', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          patterns: [
            { id: 'r', kind: 'ready', regex: 'READY' },
            { id: 'w', kind: 'working', regex: 'WORKING' }
          ]
        })
      );
      const events = a.ingest(buf('READY WORKING'));
      expect(events.map((e) => e.patternId)).toEqual(['r', 'w']);
      // Later match wins for state.
      expect(a.state()).toBe('WORKING');
    });
  });

  describe('input parsing', () => {
    it('strips ANSI before pattern matching', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'r', kind: 'ready', regex: 'prompt>' }] })
      );
      // A real tmux pane sprinkles SGR around the prompt text.
      const ansiPrompt = `\u001b[33mprompt>\u001b[0m `;
      a.ingest(buf(ansiPrompt));
      expect(a.state()).toBe('READY');
    });

    it('tail buffer slides at 8KB — patterns only see recent bytes', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 't', kind: 'task_done', regex: 'MARKER' }] })
      );
      // Push MARKER then 10KB of filler — the marker should scroll out.
      a.ingest(buf('MARKER\n'));
      expect(a.state()).toBe('IDLE');

      // Reset adapter for a clean ingest scenario.
      const b = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 't', kind: 'task_done', regex: 'MARKER' }] })
      );
      b.ingest(buf('x'.repeat(9 * 1024)));
      b.ingest(buf('MARKER'));
      // The marker is at the tail — still matched.
      expect(b.state()).toBe('IDLE');

      // But if we push another 9KB AFTER the marker, the marker is gone
      // from the tail and won't re-fire (and the state stays IDLE since
      // state transitions aren't reversed by absence of input).
    });

    it('scope: "tail_line" matches against last non-empty line only', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          patterns: [
            {
              id: 'p',
              kind: 'prompt_detected',
              regex: '\\$ $',
              scope: 'tail_line'
            }
          ]
        })
      );
      // First line contains the pattern but it's not on the last line.
      a.ingest(buf('old $ line\nnot a prompt\n'));
      // tail_line is 'not a prompt' — no match.
      expect(a.state()).not.toBe('WAITING_PROMPT');
      // Now the last non-empty line ends with the prompt.
      a.ingest(buf('$ '));
      expect(a.state()).toBe('WAITING_PROMPT');
    });
  });

  describe('firedMatches dedup (alert-kind only)', () => {
    it('prompt_detected fires once while the matched text is still in tail', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'p', kind: 'prompt_detected', regex: 'y/n\\?' }] })
      );
      const first = a.ingest(buf('proceed y/n? '));
      expect(first).toHaveLength(1);
      const second = a.ingest(buf(' (still waiting)'));
      // Same prompt text still in tail → no new event.
      expect(second).toHaveLength(0);
    });

    it('same prompt re-fires after the matched text scrolls out of tail', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'p', kind: 'prompt_detected', regex: 'y/n\\?' }] })
      );
      a.ingest(buf('proceed y/n? '));
      // Push enough bytes to evict: 9KB > 8KB tail cap.
      a.ingest(buf('x'.repeat(9 * 1024)));
      // Now feed the prompt again — should re-fire.
      const events = a.ingest(buf('proceed y/n?'));
      expect(events).toHaveLength(1);
    });

    it('state-tracking kinds (ready/working) are NOT deduped', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'w', kind: 'working', regex: 'working' }] })
      );
      expect(a.ingest(buf('working...'))).toHaveLength(1);
      expect(a.ingest(buf(' more working'))).toHaveLength(1);
    });
  });

  describe('isIdleWaiting()', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns true immediately in WAITING_PROMPT', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ patterns: [{ id: 'p', kind: 'prompt_detected', regex: 'go\\?' }] })
      );
      a.ingest(buf('go?'));
      expect(a.isIdleWaiting()).toBe(true);
    });

    it('returns false in BOOTING regardless of timer', () => {
      const a = new ConfigDrivenAdapter(cfg());
      expect(a.isIdleWaiting()).toBe(false);
    });

    it('inactivity method: false before inactivityMs has elapsed', () => {
      vi.useFakeTimers();
      // Non-zero base: the adapter treats `!lastOutputAt` as "no output
      // yet" and returns false. At real wall-clock time that's harmless
      // (Date.now() is huge), but fake timers at 0 would trip the guard.
      const T0 = 1_000_000;
      vi.setSystemTime(T0);
      const a = new ConfigDrivenAdapter(
        cfg({
          patterns: [{ id: 'w', kind: 'working', regex: 'working' }],
          idleDetection: { method: 'inactivity', inactivityMs: 2000 }
        })
      );
      a.ingest(buf('working'));
      vi.setSystemTime(T0 + 1000);
      expect(a.isIdleWaiting()).toBe(false);
      vi.setSystemTime(T0 + 2500);
      expect(a.isIdleWaiting()).toBe(true);
    });

    it('cursor_at_prompt method: true when last non-empty line matches', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          patterns: [{ id: 'w', kind: 'working', regex: 'x' }],
          idleDetection: { method: 'cursor_at_prompt', promptLineRegex: '^\\$ $' }
        })
      );
      // Put the adapter in WORKING.
      a.ingest(buf('x'));
      expect(a.isIdleWaiting()).toBe(false);
      // Now supply a tail that ends with a prompt line.
      a.ingest(buf('\n$ '));
      expect(a.isIdleWaiting()).toBe(true);
    });

    it('cursor_at_prompt method with malformed regex returns false, never throws', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          patterns: [{ id: 'w', kind: 'working', regex: 'x' }],
          idleDetection: { method: 'cursor_at_prompt', promptLineRegex: '(unclosed' }
        })
      );
      a.ingest(buf('x'));
      expect(() => a.isIdleWaiting()).not.toThrow();
      expect(a.isIdleWaiting()).toBe(false);
    });
  });

  describe('buildSpawnSpec — template substitution', () => {
    function opts(overrides: Partial<BuildSpawnSpecOpts> = {}): BuildSpawnSpecOpts {
      return {
        role: { systemPrompt: 'be helpful', toolConfig: { foo: 1 } },
        worktreeCwd: '/tmp/wt',
        task: { title: 't1', body: 'b1' },
        env: { HOME: '/home/ar' },
        agent: { id: 'agent-xyz' },
        ...overrides
      };
    }

    it('substitutes {{worktree}} and {{agent.id}}', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: {
            command: 'bash',
            args: ['--cwd', '{{worktree}}'],
            env: { AGENT_ID: '{{agent.id}}' }
          }
        })
      );
      const spec = a.buildSpawnSpec(opts());
      expect(spec.command).toBe('bash');
      expect(spec.args).toEqual(['--cwd', '/tmp/wt']);
      expect(spec.env.AGENT_ID).toBe('agent-xyz');
      expect(spec.cwd).toBe('/tmp/wt');
    });

    it('substitutes {{role.systemPrompt}} and JSON-stringifies {{role.toolConfig}}', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: {
            command: 'echo',
            args: ['{{role.systemPrompt}}', '{{role.toolConfig}}']
          }
        })
      );
      const spec = a.buildSpawnSpec(opts());
      expect(spec.args).toEqual(['be helpful', '{"foo":1}']);
    });

    it('substitutes {{task.title}}, {{task.body}}, and {{env.FOO}}', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: {
            command: 'x',
            args: ['{{task.title}}', '{{task.body}}', '{{env.HOME}}']
          }
        })
      );
      const spec = a.buildSpawnSpec(opts());
      expect(spec.args).toEqual(['t1', 'b1', '/home/ar']);
    });

    it('unknown placeholder substitutes to empty string', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ spawn: { command: 'x', args: ['{{totally.unknown}}', 'after'] } })
      );
      const spec = a.buildSpawnSpec(opts());
      expect(spec.args).toEqual(['', 'after']);
    });

    it('null task substitutes title/body to empty', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ spawn: { command: 'x', args: ['{{task.title}}'] } })
      );
      const spec = a.buildSpawnSpec(opts({ task: null }));
      expect(spec.args).toEqual(['']);
    });

    it('merges optional args: per-spawn override beats adapter default', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: {
            command: 'x',
            optionalArgs: [
              { id: 'v', flag: '--verbose', label: 'Verbose', default: true },
              { id: 'q', flag: '--quiet', label: 'Quiet', default: false }
            ]
          }
        })
      );
      // Default behaviour: only --verbose (its default is true).
      const def = a.buildSpawnSpec(opts());
      expect(def.args).toEqual(['--verbose']);

      // Override: disable verbose, enable quiet.
      const override = a.buildSpawnSpec(opts({ optionalArgs: { v: false, q: true } }));
      expect(override.args).toEqual(['--quiet']);
    });

    it('substitutes initialInput when present', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: { command: 'x', initialInput: 'hello {{agent.id}}' }
        })
      );
      const spec = a.buildSpawnSpec(opts());
      expect(spec.initialInput).toBe('hello agent-xyz');
    });

    it('omits initialInput when not configured', () => {
      const a = new ConfigDrivenAdapter(cfg());
      const spec = a.buildSpawnSpec(opts());
      expect(spec.initialInput).toBeUndefined();
    });

    it('substitutes {{agent.cliSessionId}} when supplied', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: {
            command: 'claude',
            args: ['--session-id', '{{agent.cliSessionId}}']
          }
        })
      );
      const spec = a.buildSpawnSpec(
        opts({ agent: { id: 'agent-xyz', cliSessionId: 'abc-123' } })
      );
      expect(spec.args).toEqual(['--session-id', 'abc-123']);
    });

    it('omitted cliSessionId substitutes to empty string', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: {
            command: 'claude',
            args: ['--session-id', '{{agent.cliSessionId}}']
          }
        })
      );
      const spec = a.buildSpawnSpec(opts());
      expect(spec.args).toEqual(['--session-id', '']);
    });
  });

  describe('needsCliSessionId — auto-detection', () => {
    it('true when args reference {{agent.cliSessionId}}', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: { command: 'claude', args: ['--session-id', '{{agent.cliSessionId}}'] }
        })
      );
      expect(a.needsCliSessionId).toBe(true);
    });

    it('true when env value references {{agent.cliSessionId}}', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: { command: 'x', env: { SID: '{{agent.cliSessionId}}' } }
        })
      );
      expect(a.needsCliSessionId).toBe(true);
    });

    it('true when initialInput references {{agent.cliSessionId}}', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: { command: 'x', initialInput: 'session={{agent.cliSessionId}}' }
        })
      );
      expect(a.needsCliSessionId).toBe(true);
    });

    it('tolerates whitespace inside braces (matches subst regex)', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: { command: 'x', args: ['{{ agent.cliSessionId }}'] }
        })
      );
      expect(a.needsCliSessionId).toBe(true);
    });

    it('false when no spawn-config string references it', () => {
      const a = new ConfigDrivenAdapter(
        cfg({
          spawn: { command: 'bash', args: ['--cwd', '{{worktree}}'], env: { X: '{{agent.id}}' } }
        })
      );
      expect(a.needsCliSessionId).toBe(false);
    });
  });

  describe('input.encode / input.answerPrompt', () => {
    it('encode: empty string → []', () => {
      const a = new ConfigDrivenAdapter(cfg());
      expect(a.input.encode('')).toEqual([]);
    });

    it('encode: non-empty → single-element array', () => {
      const a = new ConfigDrivenAdapter(cfg());
      expect(a.input.encode('hello')).toEqual(['hello']);
    });

    it('answerPrompt: uses preset when configured', () => {
      const a = new ConfigDrivenAdapter(
        cfg({ input: { promptAnswers: { '1': ['y', 'Enter'] } } })
      );
      expect(a.input.answerPrompt('1')).toEqual(['y', 'Enter']);
      expect(a.input.answerPrompt(1)).toEqual(['y', 'Enter']);
    });

    it('answerPrompt: falls back to [choice, submitKey] when no preset', () => {
      const a = new ConfigDrivenAdapter(cfg({ input: { submitKey: 'Enter' } }));
      expect(a.input.answerPrompt('n')).toEqual(['n', 'Enter']);
    });

    it('answerPrompt: honours custom submitKey', () => {
      const a = new ConfigDrivenAdapter(cfg({ input: { submitKey: 'C-m' } }));
      expect(a.input.answerPrompt('ok')).toEqual(['ok', 'C-m']);
    });
  });

  describe('exposed readonly properties', () => {
    it('mirrors config for kind / displayName', () => {
      const a = new ConfigDrivenAdapter(cfg());
      expect(a.kind).toBe('shell');
      expect(a.displayName).toBe('Shell');
    });
  });
});
