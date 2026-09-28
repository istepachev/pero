import { InvalidInputError } from '../common/errors.js';

/**
 * Runs `call`, passing the messages of the daemon's input errors through
 * `rename`, so they name the command's options instead of its fields.
 */
export async function withOptionNames<T>(
  call: () => Promise<T>,
  rename: (message: string) => string,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error;
    throw new InvalidInputError(rename(error.message));
  }
}
