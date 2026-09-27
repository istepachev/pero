import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidInputError } from '../common/errors.js';
import { validateWorkingDirectory } from './working-directory.js';

describe('validateWorkingDirectory', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-folder-'));
  });

  afterEach(() => {
    chmodSync(tmp, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an accessible absolute folder, normalized', async () => {
    const vault = join(tmp, 'vault');
    mkdirSync(vault);

    await expect(validateWorkingDirectory(vault)).resolves.toBe(vault);
    await expect(validateWorkingDirectory(`${vault}/`)).resolves.toBe(vault);
    await expect(
      validateWorkingDirectory(join(tmp, 'other', '..', 'vault')),
    ).resolves.toBe(vault);
  });

  it('keeps a symbolic link as given', async () => {
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    const link = join(tmp, 'link');
    symlinkSync(vault, link);

    await expect(validateWorkingDirectory(link)).resolves.toBe(link);
  });

  it.each([
    ['', /must not be empty/],
    ['  ', /must not be empty/],
    ['vault', /must be an absolute path/],
    ['./vault', /must be an absolute path/],
    ['~/vault', /must be an absolute path/],
    ['/tmp/a\0b', /NUL byte/],
  ])('rejects %j', async (input, message) => {
    const result = validateWorkingDirectory(input);
    await expect(result).rejects.toThrow(InvalidInputError);
    await expect(result).rejects.toThrow(message);
  });

  it('rejects a missing folder or a file', async () => {
    const file = join(tmp, 'notes.md');
    writeFileSync(file, '');

    await expect(
      validateWorkingDirectory(join(tmp, 'missing')),
    ).rejects.toThrow(/does not exist/);
    await expect(validateWorkingDirectory(join(file, 'x'))).rejects.toThrow(
      /does not exist/,
    );
    await expect(validateWorkingDirectory(file)).rejects.toThrow(
      /is not a folder/,
    );
  });

  // The superuser passes every permission check.
  it.skipIf(process.getuid?.() === 0)(
    'rejects a folder this account cannot write',
    async () => {
      const locked = join(tmp, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o500);

      await expect(validateWorkingDirectory(locked)).rejects.toThrow(
        /must be readable and writable/,
      );
      chmodSync(locked, 0o700);
    },
  );
});
