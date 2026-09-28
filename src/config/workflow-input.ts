import { CronPattern } from 'croner';
import { z } from 'zod';
import { withoutUndefined } from '../common/without-undefined.js';
import { timeZoneSchema } from './settings-input.js';
import { slugSchema, titleSchema } from './slug.js';

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

/** Names an existing Agent, in any case. */
const agentReferenceSchema = z.string().trim().min(1, 'must not be empty');

/** The input each run sends to the Agent. */
const inputTemplateSchema = z
  .string()
  .refine((text) => text.trim() !== '', 'must not be empty');

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

/** The Channels a history input reads: all of them, or these IDs. */
const historyChannelsSchema = z.union(
  [
    z.literal('all'),
    z
      .array(z.int().positive())
      .min(1)
      .transform((ids) => [...new Set(ids)].sort((a, b) => a - b)),
  ],
  { error: 'must be all, or the IDs of one or more Channels' },
);

const historyFields = {
  channels: historyChannelsSchema,
  /** `people`: only what people wrote; `all`: the Agents' replies too. */
  messages: z.enum(HISTORY_MESSAGES),
  /**
   * A fixed window of this many hours before the run starts; null reads
   * everything since the previous successful run (the last 24 hours for
   * the first).
   */
  hours: z
    .int('must be a whole number of hours')
    .min(1, 'must be at least 1')
    .max(MAX_HISTORY_HOURS, `must be at most ${MAX_HISTORY_HOURS}`)
    .nullable(),
  /** Run the Agent even when the window has no messages. */
  runWhenEmpty: z.boolean(),
};

/**
 * The Channel history a Workflow's runs read as input, stored in
 * `workflows.history_json`.
 */
export const workflowHistorySchema = z.strictObject(historyFields);

export type WorkflowHistory = z.output<typeof workflowHistorySchema>;

/** A history input with only the defaults. */
export const DEFAULT_WORKFLOW_HISTORY: WorkflowHistory = {
  channels: 'all',
  messages: 'people',
  hours: null,
  runWhenEmpty: false,
};

/**
 * Changes to a history input; an omitted field keeps its value, or takes
 * the default when the Workflow reads no history yet.
 */
export const workflowHistoryPatchSchema = z
  .strictObject(historyFields)
  .partial();

export type WorkflowHistoryPatch = z.input<typeof workflowHistoryPatchSchema>;

/** `current`, or the defaults when null, with the fields `patch` sets. */
export function patchHistory(
  current: WorkflowHistory | null,
  patch: z.output<typeof workflowHistoryPatchSchema>,
): WorkflowHistory {
  return {
    ...(current ?? DEFAULT_WORKFLOW_HISTORY),
    ...withoutUndefined(patch),
  };
}

/** A new Workflow; its Agent must exist and be enabled. */
export const workflowCreateSchema = z.strictObject({
  name: slugSchema,
  title: titleSchema.optional(),
  agent: agentReferenceSchema,
  inputTemplate: inputTemplateSchema,
  maxAttempts: workflowMaxAttemptsSchema.optional(),
  /** Omitted, runs read no history. */
  history: workflowHistoryPatchSchema.optional(),
});

/** Changes to a Workflow; an omitted field keeps its value. */
export const workflowEditSchema = z.strictObject({
  title: titleSchema.optional(),
  agent: agentReferenceSchema.optional(),
  inputTemplate: inputTemplateSchema.optional(),
  maxAttempts: workflowMaxAttemptsSchema.optional(),
  enabled: z.boolean().optional(),
  /** Null stops runs reading history. */
  history: workflowHistoryPatchSchema.nullable().optional(),
});

/** Names an existing Workflow, in any case. */
export const workflowReferenceSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty');

/**
 * A new Trigger for a Workflow. A schedule without a time zone takes the
 * installation's, copied when it is added.
 */
export const triggerAddSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    workflow: workflowReferenceSchema,
    kind: z.literal('schedule'),
    cron: cronSchema,
    timezone: timeZoneSchema.optional(),
  }),
  z.strictObject({
    workflow: workflowReferenceSchema,
    kind: z.literal('manual'),
  }),
]);

export type WorkflowCreate = z.input<typeof workflowCreateSchema>;
export type WorkflowEdit = z.input<typeof workflowEditSchema>;
export type TriggerAdd = z.input<typeof triggerAddSchema>;

/** What a schedule Trigger stores in `config_json`. */
export const scheduleConfigSchema = z.object({ cron: z.string() });
