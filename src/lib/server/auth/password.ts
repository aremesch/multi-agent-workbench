/**
 * Argon2id password hashing via @node-rs/argon2.
 *
 * Argon2id is @node-rs/argon2's default, so we omit the `algorithm` option
 * (the exported Algorithm enum is a const enum and is unusable under TS's
 * verbatimModuleSyntax). Defaults are tuned for interactive logins (~100ms
 * on modern CPUs).
 */

import { hash, verify } from '@node-rs/argon2';

const options = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1
};

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, options);
}

export function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  return verify(storedHash, plain);
}
