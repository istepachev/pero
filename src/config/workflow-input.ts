import { CronPattern } from 'croner';
import { z } from 'zod';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

const CRON_EXPECTED =
  'must be a cron expression of five fields (minute hour day month weekday), ' +
  'such as "0 9 * * *", or @hourly, @daily, @weekly, @monthly, or @yearly';

const CRON_NICKNAMES = new Set([
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@hourly',
]);

/**
 * A five-field cron expression (minute, hour, day of month, month, day of
 * week) or a nickname such as `@daily`, with its fields joined by single
 * spaces. Seconds are refused: schedules are polled, not timed to the second.
 */
export const cronSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const fields = value.split(/\s+/);
    const nickname = fields.length === 1 && value.startsWith('@');
    const cron = nickname ? value.toLowerCase() : fields.join(' ');
    if (nickname ? !CRON_NICKNAMES.has(cron) : fields.length !== 5) {
      ctx.addIssue({ code: 'custom', message: CRON_EXPECTED });
      return z.NEVER;
    }
    try {
      new CronPattern(cron, undefined, { mode: '5-part' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.addIssue({
        code: 'custom',
        message: `${CRON_EXPECTED} (${reason.replace(/^CronPattern: /, '')})`,
      });
      return z.NEVER;
    }
    return cron;
  });

/** The most times a Workflow may start one run. */
export const MAX_ATTEMPTS_LIMIT = 10;

/**
 * How many times a run may start in all: 1 leaves a run Pero stopped for
 * the owner, more queues it again on startup until it has started that
 * often.
 */
export const workflowMaxAttemptsSchema = z
  .int('must be a whole number')
  .min(1, 'must be at least 1')
  .max(MAX_ATTEMPTS_LIMIT, `must be at most ${MAX_ATTEMPTS_LIMIT}`);

/** The longest fixed history window, in hours: 30 days. */
export const MAX_HISTORY_HOURS = 720;

/** Which messages a Workflow's history input reads. */
export const HISTORY_MESSAGES = ['people', 'all'] as const;

export type HistoryMessages = (typeof HISTORY_MESSAGES)[number];

/** Names an existing Workflow, in any case. */
export const workflowReferenceSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty');
