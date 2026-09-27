import { z } from 'zod';
import { PROVIDERS, providerDefaultsPatchSchema } from './provider-options.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * An IANA time zone, stored in its canonical spelling (`utc` becomes `UTC`).
 * Fixed offsets such as `+05:00` are refused: they ignore daylight saving.
 */
export const timeZoneSchema = z.string().transform((value, ctx) => {
  let zone: string | undefined;
  try {
    zone = new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    zone = undefined;
  }
  if (zone === undefined || !/^[A-Za-z]/.test(zone)) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be an IANA time zone such as Europe/Berlin',
    });
    return z.NEVER;
  }
  return zone;
});

/** Changes to installation settings; an omitted field keeps its value. */
export const settingsUpdateSchema = z.strictObject({
  defaultProvider: z.enum(PROVIDERS).optional(),
  providerDefaults: providerDefaultsPatchSchema.optional(),
  /** An absolute folder; once set it can be changed but not cleared. */
  defaultWorkingDirectory: z
    .string({
      error: (issue) =>
        issue.input === null
          ? 'cannot be cleared once set; choose another folder instead'
          : undefined,
    })
    .optional(),
  sharedInstructions: z.string().nullable().optional(),
  timezone: timeZoneSchema.optional(),
  maxConcurrentRuns: z.int().min(1).optional(),
  shutdownTimeoutMs: z.int().min(0).optional(),
});

export type SettingsUpdate = z.input<typeof settingsUpdateSchema>;
