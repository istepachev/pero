import { CliError } from './errors.js';
import { positiveInt } from './positive-int.js';

/** The Channel ID the owner typed; a `CliError` when it is not one. */
export function channelId(value: string): number {
  const id = positiveInt(value);
  if (id === null) {
    throw new CliError(
      `channel must be a Channel ID, as pero channels ls lists it, not "${value}"`,
    );
  }
  return id;
}
