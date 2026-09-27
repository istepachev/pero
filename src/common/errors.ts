import type { z } from 'zod';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** A request the owner can correct; the message says what to change. */
export class InvalidInputError extends Error {
  override name = 'InvalidInputError';
}

/** A request that names a record that does not exist. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** A request that would duplicate a record that must be unique. */
export class ConflictError extends Error {
  override name = 'ConflictError';
}

/** Parses `value`, raising `InvalidInputError` that names each bad field. */
export function parseInput<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidInputError(describeIssues(result.error));
  }
  return result.data;
}

/** One line per issue, prefixed with the field path when there is one. */
export function describeIssues(error: z.ZodError, prefix?: string): string {
  return error.issues
    .map((issue) => {
      const path = [...(prefix ? [prefix] : []), ...issue.path].join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
