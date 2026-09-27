import { z } from 'zod';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

export const SLUG_MAX_LENGTH = 64;

/**
 * Names the CLI addresses things by, such as Agents and Workflows: lowercase
 * letters and digits in words joined by single hyphens, so they never need
 * quoting and differ by more than case.
 */
export const slugSchema = z
  .string()
  .max(SLUG_MAX_LENGTH, `must be at most ${SLUG_MAX_LENGTH} characters`)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'must be lowercase letters and digits, in words joined by single hyphens',
  );

/** A display name shown next to a slug; null shows the slug. */
export const titleSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .nullable();
