import { z } from 'zod';
import { PROVIDERS, providerDefaultsPatchSchema } from './provider-options.js';
import { permissionModeSchema } from './tool-policy.js';

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
  /** Messages a replacing Session starts with; 0 turns carry-over off. */
  historyCarryover: z.int().min(0).optional(),
  /** How new Agents' tools are approved; existing Agents keep theirs. */
  defaultPermissions: permissionModeSchema.optional(),
  timezone: timeZoneSchema.optional(),
  maxConcurrentRuns: z.int().min(1).optional(),
});

export type SettingsUpdate = z.input<typeof settingsUpdateSchema>;

/** Environment variable with a Telegram bot token; wins over a stored one. */
export const TELEGRAM_TOKEN_ENV = 'PERO_TELEGRAM_BOT_TOKEN';

/** A Telegram bot token as @BotFather issues it. Issues never echo it. */
export const telegramBotTokenSchema = z
  .string()
  .trim()
  .regex(
    /^\d+:[\w-]{30,}$/,
    'must be a bot token from @BotFather, such as 123456789:AAE…',
  );

/**
 * Changes through the control endpoint: settings plus the Telegram bot
 * token, which is stored as a secret rather than in SQLite. A null token
 * removes the stored one.
 */
export const settingsChangeSchema = settingsUpdateSchema.extend({
  telegramBotToken: telegramBotTokenSchema.nullable().optional(),
});

export type SettingsChange = z.input<typeof settingsChangeSchema>;
