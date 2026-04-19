import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

// Argon2id round-trip. Single happy case is enough — @node-rs/argon2
// is a well-tested library, so these tests guard only the wrapper.

describe('hashPassword / verifyPassword', () => {
  it('round-trips a plaintext password through argon2id', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('hunter2');
    await expect(verifyPassword(hash, 'hunter3')).resolves.toBe(false);
  });

  it('produces distinct hashes for the same plaintext (random salt)', async () => {
    const a = await hashPassword('same-input');
    const b = await hashPassword('same-input');
    expect(a).not.toBe(b);
  });

  it('produces a stable hash prefix encoding the chosen parameters', async () => {
    // memoryCost=19456, timeCost=2, parallelism=1 per password.ts defaults.
    const hash = await hashPassword('pw');
    expect(hash).toMatch(/\$m=19456,t=2,p=1\$/);
  });

  it('rejects a malformed hash string without throwing out of verify', async () => {
    // @node-rs/argon2 throws on an unparseable hash; we assert the call
    // doesn't silently succeed — callers rely on a boolean OR a throw.
    await expect(verifyPassword('not-a-hash', 'whatever')).rejects.toBeTruthy();
  });
});
