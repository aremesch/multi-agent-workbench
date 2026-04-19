import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizeTokenUsage } from './ClaudeJsonlTokens.js';

// Phase 4 — token usage aggregator. Pairs with ClaudeJsonlHistory.test.ts;
// both read the same JSONL transcript but answer different questions, so
// they own separate test modules.

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'maw-jsonl-tokens-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJsonl(entries: Array<object | string>, name = 'session.jsonl'): string {
  const file = join(tempDir, name);
  const body = entries
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .join('\n');
  writeFileSync(file, body, 'utf8');
  return file;
}

function assistantEntry(usage: Record<string, number | undefined> | null) {
  return {
    type: 'assistant',
    message: usage === null ? {} : { usage }
  };
}

describe('summarizeTokenUsage — file I/O boundary', () => {
  it('returns null when the file does not exist', async () => {
    const out = await summarizeTokenUsage(join(tempDir, 'missing.jsonl'));
    expect(out).toBeNull();
  });

  it('returns an all-zero summary for an empty file', async () => {
    const file = writeJsonl([]);
    const out = await summarizeTokenUsage(file);
    expect(out).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });
  });

  it('propagates non-ENOENT fs errors', async () => {
    // A directory path as the filename triggers EISDIR.
    await expect(summarizeTokenUsage(tempDir)).rejects.toMatchObject({
      code: expect.stringMatching(/^EISDIR$/)
    });
  });
});

describe('summarizeTokenUsage — aggregation', () => {
  it('sums all four token fields across one assistant entry', async () => {
    const file = writeJsonl([
      assistantEntry({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5
      })
    ]);
    const out = await summarizeTokenUsage(file);
    expect(out).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5
    });
  });

  it('accumulates across multiple assistant entries', async () => {
    const file = writeJsonl([
      assistantEntry({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }),
      assistantEntry({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }),
      assistantEntry({ input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 300, cache_read_input_tokens: 400 })
    ]);
    const out = await summarizeTokenUsage(file);
    expect(out).toEqual({
      inputTokens: 111,
      outputTokens: 222,
      cacheCreationTokens: 333,
      cacheReadTokens: 444
    });
  });

  it('is zero-safe when individual usage fields are missing (partial usage blobs)', async () => {
    const file = writeJsonl([
      assistantEntry({ input_tokens: 50, output_tokens: 10 }), // no cache fields
      assistantEntry({ cache_creation_input_tokens: 7 }), // only cache-create
      assistantEntry({ cache_read_input_tokens: 9 }) // only cache-read
    ]);
    const out = await summarizeTokenUsage(file);
    expect(out).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cacheCreationTokens: 7,
      cacheReadTokens: 9
    });
  });

  it('treats an assistant entry without usage as a zero contribution', async () => {
    const file = writeJsonl([
      assistantEntry(null), // no .usage field
      assistantEntry({ input_tokens: 5, output_tokens: 5 })
    ]);
    const out = await summarizeTokenUsage(file);
    expect(out).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });
  });

  it('treats an assistant entry without a message as a zero contribution', async () => {
    const file = writeJsonl([
      { type: 'assistant' }, // no .message field at all
      assistantEntry({ input_tokens: 3 })
    ]);
    const out = await summarizeTokenUsage(file);
    expect(out?.inputTokens).toBe(3);
  });

  it('sums zero values without tipping over into NaN', async () => {
    const file = writeJsonl([
      assistantEntry({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    ]);
    const out = await summarizeTokenUsage(file);
    expect(out).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    });
  });
});

describe('summarizeTokenUsage — filtering', () => {
  it('ignores every entry whose outer type is not "assistant"', async () => {
    const file = writeJsonl([
      { type: 'user', message: { usage: { input_tokens: 9999 } } }, // ignored
      { type: 'message', message: { role: 'assistant', usage: { input_tokens: 9999 } } }, // still not "assistant" at outer level
      { type: 'file-history-snapshot', message: { usage: { input_tokens: 9999 } } }, // ignored
      assistantEntry({ input_tokens: 42 }) // counted
    ]);
    const out = await summarizeTokenUsage(file);
    expect(out?.inputTokens).toBe(42);
    expect(out?.outputTokens).toBe(0);
  });

  it('drops malformed JSON lines silently', async () => {
    const file = writeJsonl([
      'not json at all',
      '{"type":"assistant","message":{"usage":{"input_tokens":', // truncated
      assistantEntry({ input_tokens: 7 })
    ]);
    const out = await summarizeTokenUsage(file);
    expect(out?.inputTokens).toBe(7);
  });

  it('skips blank / whitespace-only lines', async () => {
    const file = join(tempDir, 'mixed.jsonl');
    const body = [
      '',
      '   ',
      JSON.stringify(assistantEntry({ input_tokens: 4 })),
      '\t',
      JSON.stringify(assistantEntry({ input_tokens: 6 }))
    ].join('\n');
    writeFileSync(file, body, 'utf8');
    const out = await summarizeTokenUsage(file);
    expect(out?.inputTokens).toBe(10);
  });
});
