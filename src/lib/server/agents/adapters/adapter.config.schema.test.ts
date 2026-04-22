import { describe, expect, it } from 'vitest';
import { adapterConfigSchema } from './adapter.config.schema.js';

/**
 * Minimum set of explicitly-required fields. Every other key on the
 * schema has a `.default()` applied and can be omitted.
 */
function minimal(): Record<string, unknown> {
  return {
    kind: 'shell',
    displayName: 'Shell',
    spawn: { command: 'bash' },
    input: {}
  };
}

describe('adapterConfigSchema', () => {
  describe('required fields', () => {
    it('parses a minimal config with all defaults applied', () => {
      const result = adapterConfigSchema.safeParse(minimal());
      expect(result.success).toBe(true);
      if (!result.success) return;
      const cfg = result.data;
      expect(cfg.kind).toBe('shell');
      expect(cfg.displayName).toBe('Shell');
      expect(cfg.spawn.command).toBe('bash');
    });

    it('rejects a config missing `kind`', () => {
      const { kind: _kind, ...without } = minimal();
      const r = adapterConfigSchema.safeParse(without);
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.join('.') === 'kind')).toBe(true);
      }
    });

    it('rejects a config missing `displayName`', () => {
      const { displayName: _d, ...without } = minimal();
      const r = adapterConfigSchema.safeParse(without);
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.join('.') === 'displayName')).toBe(true);
      }
    });

    it('rejects a config missing `spawn.command`', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        spawn: { args: [] }
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.join('.') === 'spawn.command')).toBe(true);
      }
    });

    it('rejects empty-string `kind`', () => {
      const r = adapterConfigSchema.safeParse({ ...minimal(), kind: '' });
      expect(r.success).toBe(false);
    });
  });

  describe('defaults', () => {
    it('idleDetection defaults: method=inactivity, inactivityMs=2000', () => {
      const r = adapterConfigSchema.parse(minimal());
      expect(r.idleDetection.method).toBe('inactivity');
      expect(r.idleDetection.inactivityMs).toBe(2000);
      expect(r.idleDetection.promptLineRegex).toBeUndefined();
    });

    it('idleDetection accepts cursor_at_prompt method with a regex', () => {
      const r = adapterConfigSchema.parse({
        ...minimal(),
        idleDetection: { method: 'cursor_at_prompt', promptLineRegex: '\\$\\s*$' }
      });
      expect(r.idleDetection.method).toBe('cursor_at_prompt');
      expect(r.idleDetection.promptLineRegex).toBe('\\$\\s*$');
      expect(r.idleDetection.inactivityMs).toBe(2000); // still defaulted
    });

    it('idleDetection rejects non-positive inactivityMs', () => {
      const bad = adapterConfigSchema.safeParse({
        ...minimal(),
        idleDetection: { inactivityMs: 0 }
      });
      expect(bad.success).toBe(false);
      const neg = adapterConfigSchema.safeParse({
        ...minimal(),
        idleDetection: { inactivityMs: -5 }
      });
      expect(neg.success).toBe(false);
    });

    it('spawn.{args,optionalArgs,env} default to empty', () => {
      const r = adapterConfigSchema.parse(minimal());
      expect(r.spawn.args).toEqual([]);
      expect(r.spawn.optionalArgs).toEqual([]);
      expect(r.spawn.env).toEqual({});
    });

    it('input defaults to literal encoding + Enter submit', () => {
      const r = adapterConfigSchema.parse(minimal());
      expect(r.input.encoding).toBe('literal');
      expect(r.input.submitKey).toBe('Enter');
      expect(r.input.promptAnswers).toEqual({});
    });

    it('patterns defaults to empty array', () => {
      const r = adapterConfigSchema.parse(minimal());
      expect(r.patterns).toEqual([]);
    });

    it('defaults.autoAnswer defaults to empty array', () => {
      const r = adapterConfigSchema.parse(minimal());
      expect(r.defaults.autoAnswer).toEqual([]);
    });
  });

  describe('patterns', () => {
    it('accepts a valid pattern with all optional fields', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        patterns: [
          {
            id: 'ready-marker',
            kind: 'ready',
            regex: '>>>',
            flags: 'm',
            scope: 'tail_line',
            severity: 'info',
            description: 'prompt ready',
            choices: ['yes', 'no']
          }
        ]
      });
      expect(r.success).toBe(true);
    });

    it('scope defaults to "tail"', () => {
      const r = adapterConfigSchema.parse({
        ...minimal(),
        patterns: [{ id: 'p', kind: 'working', regex: 'x' }]
      });
      expect(r.patterns[0]?.scope).toBe('tail');
    });

    it('rejects unknown pattern.kind', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        patterns: [{ id: 'p', kind: 'totally-invalid', regex: 'x' }]
      });
      expect(r.success).toBe(false);
    });

    it('rejects empty regex', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        patterns: [{ id: 'p', kind: 'working', regex: '' }]
      });
      expect(r.success).toBe(false);
    });

    it('does NOT validate regex correctness — that happens in AdapterRegistry.loadFile', () => {
      // A syntactically-broken regex passes schema validation; the registry
      // is responsible for compiling it and rejecting at load time.
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        patterns: [{ id: 'p', kind: 'working', regex: '(unclosed' }]
      });
      expect(r.success).toBe(true);
    });
  });

  describe('mobileQuickKeys', () => {
    it('defaults to an empty array when omitted', () => {
      const r = adapterConfigSchema.parse(minimal());
      expect(r.mobileQuickKeys).toEqual([]);
    });

    it('accepts a well-formed entry', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        mobileQuickKeys: [{ id: 'arrow-up', label: '\u2191', keys: '\u001b[A' }]
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.mobileQuickKeys).toEqual([
          { id: 'arrow-up', label: '\u2191', keys: '\u001b[A' }
        ]);
      }
    });

    it('rejects an id containing uppercase or illegal chars', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        mobileQuickKeys: [{ id: 'ArrowUp', label: '\u2191', keys: '\u001b[A' }]
      });
      expect(r.success).toBe(false);
    });

    it('rejects an empty label', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        mobileQuickKeys: [{ id: 'a', label: '', keys: 'x' }]
      });
      expect(r.success).toBe(false);
    });

    it('rejects empty keys', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        mobileQuickKeys: [{ id: 'a', label: 'A', keys: '' }]
      });
      expect(r.success).toBe(false);
    });

    it('rejects duplicate ids within the same adapter', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        mobileQuickKeys: [
          { id: 'dup', label: 'A', keys: 'x' },
          { id: 'dup', label: 'B', keys: 'y' }
        ]
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(
          r.error.issues.some((i) => /duplicate mobileQuickKeys id 'dup'/.test(i.message))
        ).toBe(true);
      }
    });
  });

  describe('input block', () => {
    it('accepts promptAnswers record of tmux key arrays', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        input: { promptAnswers: { '1': ['y', 'Enter'] } }
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.input.promptAnswers['1']).toEqual(['y', 'Enter']);
    });

    it('rejects empty tmux keys in promptAnswers', () => {
      const r = adapterConfigSchema.safeParse({
        ...minimal(),
        input: { promptAnswers: { '1': [''] } }
      });
      expect(r.success).toBe(false);
    });
  });
});
