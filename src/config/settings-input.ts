import { z } from 'zod';

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

/** The longest `historyRetentionDays`: a hundred years. */
export const MAX_HISTORY_RETENTION_DAYS = 36_500;

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
