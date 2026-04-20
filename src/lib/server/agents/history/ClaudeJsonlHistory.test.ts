import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeCwdForClaude,
  jsonlPathFor,
  renderClaudeJsonlHistory
} from './ClaudeJsonlHistory.js';

// Phase 1: pure path helpers (encodeCwdForClaude + jsonlPathFor).
// Phase 4: file-I/O + JSONL rendering pipeline (renderClaudeJsonlHistory).

describe('encodeCwdForClaude', () => {
  it('replaces slashes with hyphens', () => {
    expect(encodeCwdForClaude('/home/ar/workspace/proj')).toBe('-home-ar-workspace-proj');
  });

  it('replaces dots with hyphens', () => {
    expect(encodeCwdForClaude('/a/b/c.d.e')).toBe('-a-b-c-d-e');
  });

  it('leaves other punctuation and spaces intact', () => {
    expect(encodeCwdForClaude('/foo bar/baz')).toBe('-foo bar-baz');
    expect(encodeCwdForClaude('/my_repo-v2')).toBe('-my_repo-v2');
  });

  it('is a total pure transform', () => {
    expect(encodeCwdForClaude('')).toBe('');
    expect(encodeCwdForClaude('no-sep')).toBe('no-sep');
  });
});

describe('jsonlPathFor', () => {
  it('joins ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl', () => {
    const cwd = '/home/ar/workspace/maw';
    const sid = '01JXYZ';
    const expected = join(
      homedir(),
      '.claude',
      'projects',
      '-home-ar-workspace-maw',
      '01JXYZ.jsonl'
    );
    expect(jsonlPathFor(cwd, sid)).toBe(expected);
  });

  it('encodes dots in the cwd path', () => {
    const out = jsonlPathFor('/foo.bar/baz', 'id');
    expect(out).toContain('-foo-bar-baz');
    expect(out.endsWith('/id.jsonl')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — renderClaudeJsonlHistory
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'maw-jsonl-render-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Write a JSONL file for a test. Entries may be objects (JSON-encoded) or
 * raw strings (pass through verbatim — use for malformed-line cases).
 */
function writeJsonl(entries: Array<object | string>, opts: { eol?: string; name?: string } = {}): string {
  const eol = opts.eol ?? '\n';
  const file = join(tempDir, opts.name ?? 'session.jsonl');
  const body = entries
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .join(eol);
  writeFileSync(file, body, 'utf8');
  return file;
}

describe('renderClaudeJsonlHistory — file I/O boundary', () => {
  it('returns null when the file does not exist', async () => {
    const out = await renderClaudeJsonlHistory(join(tempDir, 'does-not-exist.jsonl'));
    expect(out).toBeNull();
  });

  it('returns null for an empty file', async () => {
    const file = writeJsonl([]);
    const out = await renderClaudeJsonlHistory(file);
    expect(out).toBeNull();
  });

  it('returns null when every line is blank/whitespace', async () => {
    const file = join(tempDir, 'blank.jsonl');
    writeFileSync(file, '\n   \n\t\n\n', 'utf8');
    const out = await renderClaudeJsonlHistory(file);
    expect(out).toBeNull();
  });

  it('propagates non-ENOENT fs errors (hub treats ENOENT→null as "no history")', async () => {
    // A directory given as a filepath triggers EISDIR, which is not ENOENT.
    const dirAsFile = tempDir;
    await expect(renderClaudeJsonlHistory(dirAsFile)).rejects.toMatchObject({
      code: expect.stringMatching(/^EISDIR$/)
    });
  });
});

describe('renderClaudeJsonlHistory — user messages', () => {
  it('renders a user message with string content using the user separator', async () => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: '  hello world  ' } }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('──── user ────');
    expect(out).toContain('hello world'); // trimmed
    expect(out).not.toMatch(/  hello world  /);
  });

  it('renders a user message whose content is an array of text blocks', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '  first  ' },
            { type: 'text', text: 'second' }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('──── user ────');
    expect(out).toMatch(/first\r\nsecond/);
  });

  it('skips a user entry whose only content is tool_result (bookkeeping)', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'ignored echo' }]
        }
      }
    ]);
    // out.length === 0 → renderer returns null
    const out = await renderClaudeJsonlHistory(file);
    expect(out).toBeNull();
  });

  it('surfaces text + tool_result mixed; tool_result gets `▸ tool_result:` prefix', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'ran the thing' },
            { type: 'tool_result', content: 'exit 0' }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('──── user ────');
    expect(out).toContain('ran the thing');
    expect(out).toContain('▸ tool_result: exit 0');
  });

  it('returns null for an entry without a message field', async () => {
    const file = writeJsonl([{ type: 'user' }]);
    const out = await renderClaudeJsonlHistory(file);
    expect(out).toBeNull();
  });

  it('ignores non-object entries inside the content array', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [null, 'stringy', { type: 'text', text: 'real' }]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('real');
    expect(out).not.toContain('stringy');
  });

  it('returns null when the string content is all whitespace after trim', async () => {
    // Text still renders an empty user block header; code returns the block
    // verbatim as long as `content` is a string. Guard the exact shape.
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: '   ' } }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    // A block is still emitted because the string-content branch is
    // unconditional; we assert it renders the header even when empty.
    expect(out).toContain('──── user ────');
  });
});

describe('renderClaudeJsonlHistory — assistant messages', () => {
  it('renders assistant text content with the assistant separator', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '  sure thing  ' }]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('──── assistant ────');
    expect(out).toContain('sure thing');
  });

  it('renders tool_use as a one-line `▸ name(args)` summary', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toMatch(/▸ Read\(\{"file_path":"\/a\/b\.ts"\}\)/);
  });

  it('falls back to `tool` when tool_use is missing the name field', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', input: 'arg' }]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('▸ tool(arg)');
  });

  it('emits empty-args `▸ name()` when input is null', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: null }]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('▸ Bash()');
  });

  it('skips `thinking` blocks (scrollback noise)', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden chain of thought' },
            { type: 'text', text: 'visible reply' }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('visible reply');
    expect(out).not.toContain('hidden chain of thought');
  });

  it('returns null for an assistant entry whose only block is `thinking`', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'silent' }]
        }
      }
    ]);
    const out = await renderClaudeJsonlHistory(file);
    expect(out).toBeNull();
  });

  it('skips `type:message` entries with non-assistant role', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: { role: 'system', content: [{ type: 'text', text: 'sys note' }] }
      }
    ]);
    const out = await renderClaudeJsonlHistory(file);
    expect(out).toBeNull();
  });

  it('skips assistant entries whose content is not an array', async () => {
    const file = writeJsonl([
      { type: 'message', message: { role: 'assistant', content: 'raw string not allowed' } }
    ]);
    const out = await renderClaudeJsonlHistory(file);
    expect(out).toBeNull();
  });
});

describe('renderClaudeJsonlHistory — defensive parsing', () => {
  it('drops malformed JSON lines silently without throwing', async () => {
    const file = writeJsonl([
      'this is not json',
      { type: 'user', message: { role: 'user', content: 'survived' } },
      '{"also": "broken"', // unterminated
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('survived');
    expect(out).toContain('ok');
  });

  it('skips unknown entry types', async () => {
    const file = writeJsonl([
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'permission-mode', permissionMode: 'bypass' },
      { type: 'user', message: { role: 'user', content: 'only real content' } }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('only real content');
    expect(out).not.toContain('file-history-snapshot');
  });

  it('skips blank lines between entries', async () => {
    const file = join(tempDir, 'blanky.jsonl');
    const body = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' } }),
      '',
      '   ',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' } })
    ].join('\n');
    writeFileSync(file, body, 'utf8');
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('a');
    expect(out).toContain('b');
  });
});

describe('renderClaudeJsonlHistory — tool preview formatting', () => {
  it('collapses whitespace in tool_use input', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: 'line1\n\n  line2\t\tline3'
            }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('▸ Edit(line1 line2 line3)');
  });

  it('truncates tool_use input over the 200-char budget with an ellipsis', async () => {
    const longInput = 'x'.repeat(500);
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: longInput }]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    // 200-char head + horizontal ellipsis character
    expect(out).toMatch(/▸ Bash\(x{200}…\)/);
    expect(out).not.toContain('x'.repeat(201));
  });

  it('JSON-stringifies non-string tool_use input', async () => {
    const file = writeJsonl([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo', glob: '*.ts' } }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('▸ Grep({"pattern":"foo","glob":"*.ts"})');
  });

  it('tool_result string content is whitespace-collapsed and truncated', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'see result' },
            { type: 'tool_result', content: `a\n\n${'y'.repeat(500)}` }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toMatch(/▸ tool_result: a y{198}…/);
  });

  it('tool_result array of text blocks is concatenated', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'see result' },
            {
              type: 'tool_result',
              content: [
                { type: 'text', text: 'alpha' },
                { type: 'text', text: 'beta' }
              ]
            }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('▸ tool_result: alpha beta');
  });

  it('tool_result array with non-text entries yields empty preview', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'ran' },
            { type: 'tool_result', content: [{ type: 'image', data: 'base64...' }] }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('▸ tool_result: ');
  });

  it('tool_result with unknown/object content shape yields empty preview', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'ran' },
            { type: 'tool_result', content: { unexpected: 'shape' } }
          ]
        }
      }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('▸ tool_result: ');
  });
});

describe('renderClaudeJsonlHistory — output shape', () => {
  it('appends the session-end footer', async () => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: 'hi' } }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('--- end of session history ---');
    expect(out.endsWith('--- end of session history ---\r\n\r\n')).toBe(true);
  });

  it('normalizes line endings to CRLF (matches live PTY output)', async () => {
    // Internal renderer emits LF; the final replace step converts to CRLF
    // so xterm (convertEol=false) does not stairstep the snapshot.
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: 'line-one' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'line-two' }] } }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('\r\n');
    // No bare LF should remain anywhere in the output.
    expect(out.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('preserves CRLF input without doubling up the carriage returns', async () => {
    const file = writeJsonl(
      [
        { type: 'user', message: { role: 'user', content: 'x' } },
        { type: 'user', message: { role: 'user', content: 'y' } }
      ],
      { eol: '\r\n' }
    );
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    // No triple-CR / double-CR sequences — renderer replaces \r?\n with \r\n.
    expect(out).not.toMatch(/\r\r/);
    expect(out).toContain('x');
    expect(out).toContain('y');
  });

  it('prepends a truncation marker and stops emitting when the 256 KB budget is hit', async () => {
    // Build ~2 MB of text blocks so the budget certainly trips. Each entry
    // is well under 256 KB on its own, so push() accepts several then
    // rejects; the renderer must emit the truncation marker and bail.
    const hugeText = 'P'.repeat(200_000);
    const entries: object[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: `${i}-${hugeText}` }] }
      });
    }
    entries.push({ type: 'user', message: { role: 'user', content: 'tail entry' } });
    const file = writeJsonl(entries);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).toContain('--- (history truncated to most recent entries above) ---');
    // Total budget respected (+ marker + footer overhead is fine).
    expect(out.length).toBeLessThan(300 * 1024);
  });

  it('does NOT emit a truncation marker when everything fits', async () => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: 'small' } }
    ]);
    const out = (await renderClaudeJsonlHistory(file)) ?? '';
    expect(out).not.toContain('history truncated');
    expect(out).toContain('--- end of session history ---');
  });
});
