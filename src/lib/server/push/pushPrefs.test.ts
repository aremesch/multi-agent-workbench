import { describe, expect, it } from 'vitest';
import {
  ALL_NOTIFY_KINDS,
  DEFAULT_NOTIFY_KINDS,
  parseNotifyKinds
} from './pushPrefs.js';

describe('parseNotifyKinds', () => {
  it('returns defaults for null', () => {
    expect(parseNotifyKinds(null)).toEqual(DEFAULT_NOTIFY_KINDS);
  });

  it('returns defaults for the empty string', () => {
    expect(parseNotifyKinds('')).toEqual(DEFAULT_NOTIFY_KINDS);
  });

  it('returns defaults for malformed JSON', () => {
    expect(parseNotifyKinds('not json')).toEqual(DEFAULT_NOTIFY_KINDS);
    expect(parseNotifyKinds('{broken')).toEqual(DEFAULT_NOTIFY_KINDS);
  });

  it('returns defaults for JSON that parses but is not an array', () => {
    expect(parseNotifyKinds('{"foo": "bar"}')).toEqual(DEFAULT_NOTIFY_KINDS);
    expect(parseNotifyKinds('42')).toEqual(DEFAULT_NOTIFY_KINDS);
    expect(parseNotifyKinds('null')).toEqual(DEFAULT_NOTIFY_KINDS);
    expect(parseNotifyKinds('"prompt_detected"')).toEqual(DEFAULT_NOTIFY_KINDS);
  });

  it('keeps only recognized kinds, dropping unknowns', () => {
    expect(parseNotifyKinds('["prompt_detected","unknown_kind","error"]')).toEqual([
      'prompt_detected',
      'error'
    ]);
  });

  it('accepts the full set', () => {
    expect(parseNotifyKinds(JSON.stringify(ALL_NOTIFY_KINDS))).toEqual(ALL_NOTIFY_KINDS);
  });

  it('accepts an empty array (user disabled every kind)', () => {
    expect(parseNotifyKinds('[]')).toEqual([]);
  });

  it('preserves the caller-specified order', () => {
    expect(parseNotifyKinds('["error","prompt_detected"]')).toEqual([
      'error',
      'prompt_detected'
    ]);
  });
});
