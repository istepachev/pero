import { BackupFormatError } from '../backup/archive.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import { ConfigError } from '../config/bootstrap-config.js';
import { StateDirError } from '../config/workspace-layout.js';
import { EnvFilePermissionError } from '../config/env-file.js';
import { WorkspaceInitError } from '../config/workspace-skeleton.js';
import { DaemonNotRunningError } from '../control/client.js';
import { ControlError } from '../control/protocol.js';

/** A command failure the owner can act on; its message says how. */
export class CliError extends Error {
  override name = 'CliError';

  constructor(
    message: string,
    readonly exitCode = 1,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const EXPECTED_ERRORS = [
  CliError,
  ConfigError,
  StateDirError,
  DaemonNotRunningError,
  ControlError,
  InvalidInputError,
  NotFoundError,
  ConflictError,
  BackupFormatError,
  WorkspaceInitError,
  EnvFilePermissionError,
];

/**
 * Prints a failed command's error and sets the exit code. Errors the owner
 * can act on print only their message; anything else prints in full.
 */
export function reportCliError(error: unknown): void {
  const expected = EXPECTED_ERRORS.some((type) => error instanceof type);
  console.error(expected ? (error as Error).message : error);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
}
