import { z } from 'zod';
import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  PROVIDERS,
  type Provider,
  type ProviderDefaults,
} from '../config/provider-options.js';
import {
  MAX_HISTORY_RETENTION_DAYS,
  timeZoneSchema,
} from '../config/settings-input.js';
import { slugify } from '../config/slug.js';
import {
  PERMISSION_MODES,
  type PermissionMode,
} from '../config/tool-policy.js';
import {
  cronSchema,
  HISTORY_MESSAGES,
  type HistoryMessages,
  MAX_HISTORY_HOURS,
  workflowMaxAttemptsSchema,
} from '../config/workflow-input.js';
import type { ParsedNote } from './note.js';
import { checkPropertyNames } from './properties.js';
import { DAYS, toCron } from './schedule.js';
import { fromZodIssues, type SettingsError } from './settings-error.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * The properties of `Pero.md`, Agent notes, and Workflow notes, as the
 * configuration reference describes them. A property left empty, as
 * Obsidian leaves one added without a value, counts as not set.
 */

/** The name of the main Agent when `Pero.md` names none: `Main.md`. */
export const DEFAULT_MAIN_AGENT = 'main';

export const DEFAULT_HISTORY_CARRYOVER = 50;

export const DEFAULT_MAX_CONCURRENT_RUNS = 2;

/** The most Workflow runs `max-concurrent-runs` allows at once. */
export const MAX_CONCURRENT_RUNS_LIMIT = 10;

/** Any provider's effort level; an Agent's is checked against its provider. */
export const EFFORTS = [...new Set([...CLAUDE_EFFORTS, ...CODEX_EFFORTS])] as [
  string,
  ...string[],
];

/** Installation defaults, from `Pero.md` or, without one, Pero's own. */
export interface PeroNote {
  provider: Provider;
  /** Each provider's model and effort; null lets the provider choose. */
  providerDefaults: ProviderDefaults;
  permissions: PermissionMode;
  /** Null: the host's time zone. */
  timezone: string | null;
  /** The name of the main Agent's note. */
  mainAgent: string;
  historyCarryover: number;
  /** Null keeps all history. */
  historyRetentionDays: number | null;
  maxConcurrentRuns: number;
}

/** An Agent note's own settings; null takes the value from `Pero.md`. */
export interface AgentNote {
  /** The title of the one topic it answers in; null for none. */
  topic: string | null;
  provider: Provider | null;
  model: string | null;
  /** Any provider's level; not yet checked against the Agent's provider. */
  effort: string | null;
  permissions: PermissionMode | null;
  /** As written; null works in the workspace. */
  workingDirectory: string | null;
  /** Leaves the main Agent's instructions out of its own. */
  skipMainInstructions: boolean;
  skipGitRepoCheck: boolean;
  enabled: boolean;
  /** The body. */
  instructions: string | null;
}

/** A topic title, `<chat title>/<topic title>`, or a Channel ID. */
export type ChannelRef = string | number;

export interface WorkflowNoteHistory {
  channels: 'all' | ChannelRef[];
  messages: HistoryMessages;
  /** Null: since the previous successful run. */
  hours: number | null;
  runWhenEmpty: boolean;
}

/** A Workflow note's settings. */
export interface WorkflowNote {
  /** Null: it runs only by hand. */
  schedule: { cron: string; timezone: string | null } | null;
  /** Where each run's answer is posted. */
  channels: ChannelRef[];
  /** The name of the Agent note that runs it; null: from `channel`. */
  agent: string | null;
  /** Null: runs read no chat history. */
  history: WorkflowNoteHistory | null;
  maxAttempts: number;
  enabled: boolean;
  /** The body: what each run sends to the Agent. */
  input: string;
}

export type NoteResult<T> =
  { ok: true; value: T } | { ok: false; errors: SettingsError[] };

// Values, with messages that say what to write.

const bool = z.boolean({ error: 'must be true or false' });

const text = z
  .string({ error: 'must be text' })
  .trim()
  .min(1, 'must not be empty');

function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, { error: `must be ${listing(values)}` });
}

function wholeNumber(min: number, max?: number) {
  const message =
    max === undefined
      ? `must be a whole number, ${min} or more`
      : `must be a whole number from ${min} to ${max}`;
  const number = z.int({ error: message }).min(min, message);
  return max === undefined ? number : number.max(max, message);
}

/** One value or a list of them, as a list. */
function oneOrMore<T extends z.ZodType>(item: T, min = 0, message?: string) {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value : [value]),
    z.array(item).min(min, message),
  );
}

/** Names a note, such as `Main`: its name is the slug of what is written. */
const noteName = text.transform((value, ctx) => {
  const name = slugify(value);
  if (name === null) {
    ctx.addIssue({ code: 'custom', message: 'must name a note, such as Main' });
    return z.NEVER;
  }
  return name;
});

const timeZone = z
  .string({ error: 'must be an IANA time zone such as Europe/Berlin' })
  .pipe(timeZoneSchema);

/** A topic title; one Obsidian reads as a number, such as `2026`, too. */
const topicTitle = z.preprocess(
  (value) => (typeof value === 'number' ? String(value) : value),
  text,
);

/** One topic title: an Agent answers one topic, which no other claims. */
const oneTopic = z
  .unknown()
  .superRefine((value, ctx) => {
    if (Array.isArray(value)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be one topic title, not a list: an Agent answers one topic',
      });
    }
  })
  .pipe(topicTitle);

/**
 * The topic title `value`, a `topic` property as YAML gives it, names;
 * null when it names none, as for a value of the wrong type.
 */
export function topicTitleOf(value: unknown): string | null {
  const read = oneTopic.safeParse(value);
  return read.success ? read.data : null;
}

const CHANNEL_EXPECTED = 'must be a topic title or a Channel ID';

const channelRef = z.union([z.int().positive(CHANNEL_EXPECTED), text], {
  error: CHANNEL_EXPECTED,
});

const DAY_EXPECTED =
  'must be a weekday such as sunday, or daily, weekdays, or weekends';

const day = z
  .string({ error: DAY_EXPECTED })
  .trim()
  .toLowerCase()
  .transform((value, ctx) => {
    const days = DAYS[value];
    if (days === undefined) {
      ctx.addIssue({ code: 'custom', message: DAY_EXPECTED });
      return z.NEVER;
    }
    return days;
  });

// Every property, each optional; defaults are applied after checking.

const peroProperties = z
  .object({
    provider: oneOf(PROVIDERS),
    'claude-model': text,
    'codex-model': text,
    'claude-effort': oneOf(CLAUDE_EFFORTS),
    'codex-effort': oneOf(CODEX_EFFORTS),
    permissions: oneOf(PERMISSION_MODES),
    timezone: timeZone,
    'main-agent': noteName,
    'history-carryover': wholeNumber(0),
    'history-retention-days': wholeNumber(1, MAX_HISTORY_RETENTION_DAYS),
    'max-concurrent-runs': wholeNumber(1, MAX_CONCURRENT_RUNS_LIMIT),
  })
  .partial();

const agentProperties = z
  .object({
    topic: oneTopic,
    provider: oneOf(PROVIDERS),
    model: text,
    effort: oneOf(EFFORTS),
    permissions: oneOf(PERMISSION_MODES),
    'working-directory': text.refine(
      (path) => !path.includes('\0'),
      'must not contain a NUL byte',
    ),
    'skip-main-instructions': bool,
    'skip-git-repo-check': bool,
    enabled: bool,
  })
  .partial();

const workflowProperties = z
  .object({
    day: oneOrMore(day).transform((days) => days.flat()),
    hour: oneOrMore(wholeNumber(0, 23)),
    minute: wholeNumber(0, 59),
    cron: z.string({ error: 'must be a cron expression' }).pipe(cronSchema),
    timezone: timeZone,
    channel: oneOrMore(channelRef),
    agent: noteName,
    history: bool,
    'history-channels': oneOrMore(
      channelRef,
      1,
      'must name at least one topic; leave it out to read them all',
    ),
    'history-messages': oneOf(HISTORY_MESSAGES),
    'history-hours': wholeNumber(1, MAX_HISTORY_HOURS),
    'run-when-empty': bool,
    'max-attempts': workflowMaxAttemptsSchema,
    enabled: bool,
  })
  .partial();

/** Every property each kind of note takes, by name. */
export const NOTE_PROPERTIES = {
  pero: peroProperties.keyof().options,
  agent: agentProperties.keyof().options,
  workflow: workflowProperties.keyof().options,
} as const;

/** `Pero.md`'s settings, with Pero's defaults for those it leaves out. */
export function readPeroNote(
  file: string,
  note: ParsedNote,
): NoteResult<PeroNote> {
  const result = readProperties(file, note, peroProperties);
  if (note.body !== null) {
    const error = {
      file,
      property: null,
      message:
        "holds settings only: move its text to the main Agent's note, " +
        'whose instructions every Agent starts with',
    };
    return {
      ok: false,
      errors: result.ok ? [error] : [...result.errors, error],
    };
  }
  if (!result.ok) return result;
  const p = result.value;
  return {
    ok: true,
    value: {
      provider: p.provider ?? 'claude',
      providerDefaults: {
        claude: {
          model: p['claude-model'] ?? null,
          effort: p['claude-effort'] ?? null,
        },
        codex: {
          model: p['codex-model'] ?? null,
          effort: p['codex-effort'] ?? null,
        },
      },
      permissions: p.permissions ?? 'ask',
      timezone: p.timezone ?? null,
      mainAgent: p['main-agent'] ?? DEFAULT_MAIN_AGENT,
      historyCarryover: p['history-carryover'] ?? DEFAULT_HISTORY_CARRYOVER,
      historyRetentionDays: p['history-retention-days'] ?? null,
      maxConcurrentRuns:
        p['max-concurrent-runs'] ?? DEFAULT_MAX_CONCURRENT_RUNS,
    },
  };
}

/** An Agent note's own settings. */
export function readAgentNote(
  file: string,
  note: ParsedNote,
): NoteResult<AgentNote> {
  const result = readProperties(file, note, agentProperties);
  if (!result.ok) return result;
  const p = result.value;
  return {
    ok: true,
    value: {
      topic: p.topic ?? null,
      provider: p.provider ?? null,
      model: p.model ?? null,
      effort: p.effort ?? null,
      permissions: p.permissions ?? null,
      workingDirectory: p['working-directory'] ?? null,
      skipMainInstructions: p['skip-main-instructions'] ?? false,
      skipGitRepoCheck: p['skip-git-repo-check'] ?? false,
      enabled: p.enabled ?? true,
      instructions: note.body,
    },
  };
}

/**
 * A Workflow note's settings. `day`, `hour`, and `minute` become a cron
 * expression.
 */
export function readWorkflowNote(
  file: string,
  note: ParsedNote,
): NoteResult<WorkflowNote> {
  const result = readProperties(file, note, workflowProperties);
  const errors = result.ok ? [] : result.errors;
  if (note.body === null) {
    errors.push({
      file,
      property: null,
      message: 'the note has no text: write what each run asks the Agent',
    });
  }
  if (!result.ok) return { ok: false, errors };

  const p = result.value;
  const error = (property: string, message: string) =>
    errors.push({ file, property, message });
  const timed =
    p.day !== undefined || p.hour !== undefined || p.minute !== undefined;
  if (p.cron !== undefined && timed) {
    error('cron', 'replaces day, hour, and minute; use one or the other');
  } else if (timed && p.hour === undefined) {
    error('hour', 'must be set when day or minute is');
  }
  if (errors.length > 0 || note.body === null) return { ok: false, errors };

  const cron =
    p.cron ??
    (p.hour === undefined
      ? null
      : toCron({
          days: p.day ?? DAYS.daily!,
          hours: p.hour,
          minute: p.minute ?? 0,
        }));
  return {
    ok: true,
    value: {
      schedule: cron === null ? null : { cron, timezone: p.timezone ?? null },
      channels: p.channel ?? [],
      agent: p.agent ?? null,
      history: p.history
        ? {
            channels: p['history-channels'] ?? 'all',
            messages: p['history-messages'] ?? 'people',
            hours: p['history-hours'] ?? null,
            runWhenEmpty: p['run-when-empty'] ?? false,
          }
        : null,
      maxAttempts: p['max-attempts'] ?? 1,
      enabled: p.enabled ?? true,
      input: note.body,
    },
  };
}

/**
 * `note`'s properties checked against `schema`: every unknown property
 * and every invalid value is reported, not just the first.
 */
function readProperties<S extends z.ZodObject>(
  file: string,
  note: ParsedNote,
  schema: S,
): NoteResult<z.output<S>> {
  const set = Object.fromEntries(
    Object.entries(note.properties).filter(([, value]) => value !== null),
  );
  const { properties, errors } = checkPropertyNames(
    file,
    set,
    Object.keys(schema.shape),
  );
  const parsed = schema.safeParse(properties);
  if (!parsed.success) {
    errors.push(...fromZodIssues(file, parsed.error.issues, properties));
  }
  return parsed.success && errors.length === 0
    ? { ok: true, value: parsed.data }
    : { ok: false, errors };
}

/** `a or b`, `a, b, or c`. */
export function listing(values: readonly string[]): string {
  if (values.length <= 2) return values.join(' or ');
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}
