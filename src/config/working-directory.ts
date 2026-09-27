import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { InvalidInputError } from '../common/errors.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * Checks that `input` names an existing folder this account can read, write,
 * and enter, and returns it normalized. It never creates the folder, and it
 * keeps symbolic links as given: the owner may point at a linked vault.
 */
export async function validateWorkingDirectory(input: string): Promise<string> {
  if (input.trim() === '') {
    throw new InvalidInputError('Working directory must not be empty');
  }
  if (input.includes('\0')) {
    throw new InvalidInputError(
      'Working directory must not contain a NUL byte',
    );
  }
  if (!isAbsolute(input)) {
    throw new InvalidInputError(
      `Working directory ${input} must be an absolute path`,
    );
  }
  const folder = resolve(input);

  let isDirectory: boolean;
  try {
    isDirectory = (await stat(folder)).isDirectory();
  } catch (error) {
    throw new InvalidInputError(
      isMissing(error)
        ? `Working directory ${folder} does not exist`
        : `Cannot inspect working directory ${folder}: ${reason(error)}`,
      { cause: error },
    );
  }
  if (!isDirectory) {
    throw new InvalidInputError(`Working directory ${folder} is not a folder`);
  }

  try {
    await access(folder, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new InvalidInputError(
      `Working directory ${folder} must be readable and writable by this account`,
      { cause: error },
    );
  }
  return folder;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
