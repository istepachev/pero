import { MAX_LISTED } from '../control/protocol.js';
import { CliError } from './errors.js';
import { positiveInt } from './positive-int.js';

/** A `-n` count of runs or Notifications; a `CliError` when it is not one. */
export function listLimit(value: string): number {
  const count = positiveInt(value);
  if (count === null || count > MAX_LISTED) {
    throw new CliError(
      `--lines must be a whole number from 1 to ${MAX_LISTED}, not "${value}"`,
    );
  }
  return count;
}

/** `value` when it is one of `choices`; a `CliError` naming `flag` otherwise. */
export function oneOf<T extends string>(
  flag: string,
  value: string,
  choices: readonly T[],
): T {
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new CliError(
    `${flag} must be one of ${choices.join(', ')}, not "${value}"`,
  );
}
