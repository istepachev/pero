import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteSecret, readSecret, writeSecret } from './secret-store.js';

describe('secret store', () => {
  let dir: string;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'pero-secrets-'));
    dir = join(tmp, 'secrets');
    mkdirSync(dir, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  });

  it('reads nothing before a secret is stored', () => {
    expect(readSecret(dir, 'token')).toBeNull();
  });

  it('stores a secret owner-only and reads it back', () => {
    writeSecret(dir, 'token', 'abc');

    expect(readSecret(dir, 'token')).toBe('abc');
    expect(readFileSync(join(dir, 'token'), 'utf8')).toBe('abc\n');
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
  });

  it('replaces a stored secret without leaving temporary files', () => {
    writeSecret(dir, 'token', 'first');
    writeSecret(dir, 'token', 'second');

    expect(readSecret(dir, 'token')).toBe('second');
    expect(readdirSync(dir)).toEqual(['token']);
  });

  it('trims whitespace around a value stored by hand', () => {
    writeFileSync(join(dir, 'token'), '  abc\n\n', { mode: 0o600 });

    expect(readSecret(dir, 'token')).toBe('abc');
  });

  it('deletes a secret, and deleting a missing one is fine', () => {
    writeSecret(dir, 'token', 'abc');

    deleteSecret(dir, 'token');
    deleteSecret(dir, 'token');

    expect(readSecret(dir, 'token')).toBeNull();
  });
});
