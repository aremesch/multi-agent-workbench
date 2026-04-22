import { describe, expect, it } from 'vitest';

import { parseRemoteUrl } from './remoteUrl.js';

describe('parseRemoteUrl', () => {
  describe('scheme preservation (regression: https hardcoded)', () => {
    it('preserves http:// for a bare internal gitea hostname', () => {
      expect(parseRemoteUrl('http://gitea/AI/multi-agent-workbench')).toEqual({
        provider: 'unknown',
        webBase: 'http://gitea/AI/multi-agent-workbench'
      });
    });

    it('preserves http:// for a dotted gitea hostname', () => {
      expect(parseRemoteUrl('http://gitea.example.com/foo/bar.git')).toEqual({
        provider: 'gitea',
        webBase: 'http://gitea.example.com/foo/bar'
      });
    });

    it('preserves https:// for github', () => {
      expect(parseRemoteUrl('https://github.com/anthropics/claude-code')).toEqual({
        provider: 'github',
        webBase: 'https://github.com/anthropics/claude-code'
      });
    });

    it('defaults SSH URLs to https (no scheme in source)', () => {
      expect(parseRemoteUrl('git@github.com:anthropics/claude-code.git')).toEqual({
        provider: 'github',
        webBase: 'https://github.com/anthropics/claude-code'
      });
    });
  });

  describe('normalization', () => {
    it('strips .git suffix', () => {
      expect(parseRemoteUrl('https://github.com/foo/bar.git')?.webBase).toBe(
        'https://github.com/foo/bar'
      );
    });

    it('strips trailing slash', () => {
      expect(parseRemoteUrl('https://github.com/foo/bar/')?.webBase).toBe(
        'https://github.com/foo/bar'
      );
    });

    it('strips http basic-auth userinfo', () => {
      expect(parseRemoteUrl('https://user:tok@gitea.example.com/foo/bar.git')?.webBase).toBe(
        'https://gitea.example.com/foo/bar'
      );
    });

    it('accepts ssh:// scheme with user prefix', () => {
      const r = parseRemoteUrl('ssh://git@gitea.example.com/foo/bar.git');
      expect(r?.webBase).toBe('https://gitea.example.com/foo/bar');
      expect(r?.provider).toBe('gitea');
    });
  });

  describe('provider detection', () => {
    it('classifies github.com as github', () => {
      expect(parseRemoteUrl('https://github.com/a/b')?.provider).toBe('github');
    });

    it('classifies any other dotted host as gitea', () => {
      expect(parseRemoteUrl('https://git.selfhosted.io/a/b')?.provider).toBe('gitea');
    });

    it('classifies bare-hostname (no dot) as unknown', () => {
      expect(parseRemoteUrl('http://gitea/a/b')?.provider).toBe('unknown');
    });
  });

  describe('nullish and empty', () => {
    it('returns null for null', () => {
      expect(parseRemoteUrl(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(parseRemoteUrl(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseRemoteUrl('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(parseRemoteUrl('   ')).toBeNull();
    });
  });
});
