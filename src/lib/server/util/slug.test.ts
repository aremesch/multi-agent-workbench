import { describe, expect, it } from 'vitest';
import { slugifyTitle } from './slug.js';

describe('slugifyTitle', () => {
  it('lowercases and kebabs basic words', () => {
    expect(slugifyTitle('Hello World')).toBe('hello-world');
  });

  it('strips diacritics', () => {
    expect(slugifyTitle('Übung macht den Meister')).toBe('ubung-macht-den-meister');
    expect(slugifyTitle('café résumé')).toBe('cafe-resume');
  });

  it('collapses runs of non-alphanumeric into a single dash', () => {
    expect(slugifyTitle('foo___bar!!!baz')).toBe('foo-bar-baz');
    expect(slugifyTitle('a.b.c.d')).toBe('a-b-c-d');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyTitle('---hello---')).toBe('hello');
    expect(slugifyTitle('!!!foo???')).toBe('foo');
  });

  it('caps at 60 chars', () => {
    expect(slugifyTitle('a'.repeat(70))).toBe('a'.repeat(60));
  });

  it('trims trailing dash created by the 60-char cap', () => {
    // 59 a's + space + 'boundary' → after replace = 59 a's + '-' + 'boundary'.
    // slice(0, 60) = 59 a's + '-'. Must not leave a trailing dash.
    const input = 'a'.repeat(59) + ' boundary';
    const result = slugifyTitle(input);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith('-')).toBe(false);
    expect(result).toBe('a'.repeat(59));
  });

  it('returns empty string for inputs with no sluggable chars', () => {
    expect(slugifyTitle('')).toBe('');
    expect(slugifyTitle('!!!')).toBe('');
    expect(slugifyTitle('😀🎉')).toBe('');
    expect(slugifyTitle('日本語')).toBe('');
  });

  it('slugs numeric titles cleanly', () => {
    expect(slugifyTitle('Version 1.2.3')).toBe('version-1-2-3');
  });
});
