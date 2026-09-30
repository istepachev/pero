import type { Socket } from 'node:net';
import { z } from 'zod';
import {
  PROVIDERS,
  providerDefaultsSchema,
} from '../config/provider-options.js';
import { telegramChatIdSchema } from '../config/host-config.js';
import { settingsChangeSchema } from '../config/settings-input.js';
import { PERMISSION_MODES } from '../config/tool-policy.js';
import { VALUE_ORIGINS } from '../settings-files/origins.js';
import { NEW_TOPICS } from '../settings-files/schemas.js';
import {
  HISTORY_MESSAGES,
  workflowReferenceSchema,
} from '../config/workflow-input.js';
import {
  CHAT_KINDS,
  INTEGRATION_KINDS,
  MESSAGE_DIRECTIONS,
  MESSAGE_ORIGINS,
  NOTIFICATION_STATUSES,
  RUN_STATUSES,
} from '../persistence/entities/sql.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * The control endpoint is a Unix socket in `run/`. Each connection carries
 * one request: the client writes one JSON line, the daemon answers with one
 * JSON line and closes the connection.
 */

/** Upper bound on one request or response line. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export const COMPONENT_STATES = ['unconfigured', 'degraded', 'ok'] as const;

export type ComponentState = (typeof COMPONENT_STATES)[number];

export const componentStatusSchema = z.object({
  name: z.string(),
  state: z.enum(COMPONENT_STATES),
  /** What is missing or failing; null when there is nothing to say. */
  detail: z.string().nullable(),
  /** When the component entered its current state. */
  since: z.iso.datetime(),
  /**
   * Whether health depends on it; a provider no Agent uses is listed but
   * not required. Older daemons send no flag and require everything.
   */
  required: z.boolean().default(true),
});

export type ComponentStatus = z.infer<typeof componentStatusSchema>;

export const statusResultSchema = z.object({
  pid: z.int().positive(),
  version: z.string(),
  /** The state directory: `<workspace>/.pero`, or a legacy data directory. */
  dataDir: z.string(),
  /** The workspace; null for a legacy data directory, absent before 0.2. */
  workspace: z.string().nullable().optional(),
  /** When the daemon became ready. */
  startedAt: z.iso.datetime(),
  uptimeMs: z.int().nonnegative(),
  /** `degraded` when any component is not `ok`. */
  health: z.enum(['ok', 'degraded']),
  components: z.array(componentStatusSchema),
});

export type StatusResult = z.infer<typeof statusResultSchema>;

/**
 * Where the bot token comes from: the daemon's environment, the workspace's
 * `.env`, or a legacy data directory's `secrets/`.
 */
export const TOKEN_SOURCES = ['environment', 'env-file', 'secrets'] as const;

export type TokenSource = (typeof TOKEN_SOURCES)[number];

/** Installation settings as the CLI sees them; secrets only as set or not. */
export const settingsViewSchema = z.object({
  defaultProvider: z.enum(PROVIDERS),
  providerDefaults: providerDefaultsSchema,
  defaultWorkingDirectory: z.string().nullable(),
  sharedInstructions: z.string().nullable(),
  /** The name of the Agent primary Channels get; null until one is chosen. */
  mainAgent: z.string().nullable(),
  historyCarryover: z.int(),
  /** Days of message history kept; null keeps all of it. */
  historyRetentionDays: z.int().nullable(),
  defaultPermissions: z.enum(PERMISSION_MODES),
  timezone: z.string(),
  maxConcurrentRuns: z.int(),
  telegramBotToken: z.object({
    set: z.boolean(),
    /**
     * Where the token comes from: the environment variable whenever it is
     * set, otherwise the stored secret; null when neither has one.
     */
    source: z.enum(TOKEN_SOURCES).nullable(),
  }),
  /**
   * In a workspace, where the settings are: `Pero.md` and `config.yaml`,
   * relative to the workspace when inside it; null in a legacy data
   * directory, whose settings can't be changed until it is migrated.
   */
  files: z.object({ pero: z.string(), config: z.string() }).nullable(),
  /** What a topic no Agent claims gets; null in a legacy data directory. */
  newTopics: z.enum(NEW_TOPICS).nullable(),
  /**
   * The properties `Pero.md` sets; the others are Pero's own defaults.
   * Null in a legacy data directory.
   */
  setInPero: z.array(z.string()).nullable(),
});

export type SettingsView = z.infer<typeof settingsViewSchema>;

export const backupResultSchema = z.object({
  /** Absolute path of the written archive. */
  file: z.string(),
  createdAt: z.iso.datetime(),
  bytes: z.int().nonnegative(),
  /** Whether the archive holds stored secrets such as the bot token. */
  includesSecrets: z.boolean(),
  /** Whether it holds the data folder; absent from an older daemon. */
  includesData: z.boolean().optional(),
});

export type BackupResult = z.infer<typeof backupResultSchema>;

export { telegramChatIdSchema };

export const BOT_MEMBERSHIPS = [
  'administrator',
  'member',
  'left',
  'unknown',
] as const;

/** A chat Pero serves, with the bot's standing there as last checked. */
export const allowedChatSchema = z.object({
  chatId: z.string(),
  kind: z.enum(CHAT_KINDS),
  title: z.string().nullable(),
  /** The bot's membership in a group; null for a direct chat or unchecked. */
  bot: z.enum(BOT_MEMBERSHIPS).nullable(),
  /** Whether a group has topics; null for a direct chat or unknown. */
  topics: z.boolean().nullable(),
  /** Why the bot cannot see every message there; null when it can. */
  problem: z.string().nullable(),
  /** When a daemon from before `config.yaml` recorded the allowing. */
  allowedAt: z.iso.datetime().optional(),
});

export type AllowedChatView = z.infer<typeof allowedChatSchema>;

/** A chat that is not allowed and has tried to reach Pero. */
export const pairingRequestSchema = z.object({
  chatId: z.string(),
  kind: z.enum(CHAT_KINDS),
  title: z.string().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});

export type PairingRequestView = z.infer<typeof pairingRequestSchema>;

export const telegramChatsSchema = z.object({
  /** The bot's username while connected; null otherwise. */
  bot: z.string().nullable(),
  /** Oldest first. */
  allowed: z.array(allowedChatSchema),
  /** Chats that asked to pair since the daemon started, latest first. */
  pairing: z.array(pairingRequestSchema),
});

export type TelegramChats = z.infer<typeof telegramChatsSchema>;

/** An Agent as the CLI sees it. */
export const agentViewSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  provider: z.enum(PROVIDERS),
  /** Null: the provider's default. */
  model: z.string().nullable(),
  /** Null: the provider's default. */
  effort: z.string().nullable(),
  /** The Agent's own folder; null when it follows the default. */
  workingDirectory: z.string().nullable(),
  /** The folder its turns run in. */
  effectiveWorkingDirectory: z.string(),
  /** The Agent's own instructions; null means none. */
  instructions: z.string().nullable(),
  useSharedInstructions: z.boolean(),
  permissions: z.enum(PERMISSION_MODES),
  codexSkipGitRepoCheck: z.boolean(),
  enabled: z.boolean(),
  /** Whether it is the Agent primary Channels get when onboarded. */
  main: z.boolean(),
  /**
   * The note that defines it, relative to the workspace when inside it;
   * null in a legacy data directory.
   */
  file: z.string().nullable(),
  /** Titles of the topics it claims. */
  topics: z.array(z.string()),
  /**
   * Where its values come from: the note, `Pero.md`, or Pero's defaults;
   * null in a legacy data directory.
   */
  origins: z
    .object({
      provider: z.enum(VALUE_ORIGINS),
      model: z.enum(VALUE_ORIGINS),
      effort: z.enum(VALUE_ORIGINS),
      permissions: z.enum(VALUE_ORIGINS),
      workingDirectory: z.enum(['note', 'data']),
    })
    .nullable(),
  /** Its note's errors, while its last good version stays in use. */
  errors: z.array(
    z.object({ property: z.string().nullable(), message: z.string() }),
  ),
});

export type AgentView = z.infer<typeof agentViewSchema>;

/**
 * What a Channel's next turn with its Agent does: `new` starts its first
 * Session; `resume` continues the active one; `restart` keeps the active
 * Session, whose first turn never reached the provider, and starts the
 * provider session again; `fresh` closes it for a new one, because the
 * provider or folder changed.
 */
export const NEXT_TURN_KINDS = ['new', 'resume', 'restart', 'fresh'] as const;

export const nextTurnSchema = z.object({
  kind: z.enum(NEXT_TURN_KINDS),
  /** For `fresh`: what changed since the Session began. */
  reason: z.enum(['provider', 'folder']).nullable(),
  /** For `fresh`: the provider or folder the Session began with. */
  from: z.string().nullable(),
  /** The active Session; null when there is none. */
  sessionId: z.int().nullable(),
  /** Whether the turn starts with the Channel's recent messages. */
  carriesOver: z.boolean(),
});

export type NextTurn = z.infer<typeof nextTurnSchema>;

/** A Channel that goes to an Agent now. */
export const agentChannelSchema = z.object({
  id: z.int(),
  integrationKind: z.enum(INTEGRATION_KINDS),
  /** The integration's address, such as `<chat_id>:<topic_id>`. */
  key: z.string(),
  title: z.string().nullable(),
  nextTurn: nextTurnSchema,
});

export type AgentChannelView = z.infer<typeof agentChannelSchema>;

export const agentDetailsSchema = agentViewSchema.extend({
  /** Oldest first. */
  channels: z.array(agentChannelSchema),
  /** Why its folder cannot be used now; null when it can. */
  folderProblem: z.string().nullable(),
});

export type AgentDetails = z.infer<typeof agentDetailsSchema>;

const agentNameSchema = z.string().trim().min(1, 'must not be empty');

/** A Channel as `pero channels ls` lists it. */
export const channelViewSchema = z.object({
  id: z.int(),
  integrationKind: z.enum(INTEGRATION_KINDS),
  /** The integration's address, such as `<chat_id>:<topic_id>`. */
  key: z.string(),
  title: z.string().nullable(),
  /**
   * The Agent that answers there now, chosen from the notes on each
   * message; with `agentEnabled` false, the disabled Agent that would.
   * Null when no Agent would.
   */
  agent: z.string().nullable(),
  agentEnabled: z.boolean(),
  /** Why no one answers there now; null when an Agent does. */
  unanswered: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type ChannelView = z.infer<typeof channelViewSchema>;

export const channelDetailsSchema = channelViewSchema.extend({
  /**
   * What the next turn with its Agent does with its Session; null when no
   * one answers there.
   */
  nextTurn: nextTurnSchema.nullable(),
  /** How many messages its history holds. */
  messages: z.int().nonnegative(),
  /** When the latest of them was sent; null when there is none. */
  lastMessageAt: z.iso.datetime().nullable(),
});

export type ChannelDetails = z.infer<typeof channelDetailsSchema>;

/** One message of a Channel's history. */
export const historyMessageSchema = z.object({
  id: z.int(),
  createdAt: z.iso.datetime(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  origin: z.enum(MESSAGE_ORIGINS),
  /** The Agent it was to or from; null for Pero's and Workflows' messages. */
  agent: z.string().nullable(),
  /** The Workflow whose Notification it delivered; null for other messages. */
  workflow: z.string().nullable(),
  /** The integration's ID for who wrote it; null for what Pero sent. */
  senderId: z.string().nullable(),
  text: z.string(),
});

export type HistoryMessage = z.infer<typeof historyMessageSchema>;

/** The most messages `channels.history` returns at once. */
export const MAX_HISTORY_MESSAGES = 500;

export const DEFAULT_HISTORY_MESSAGES = 20;

const channelIdSchema = z.int().positive();

/** A Channel a Workflow names: where it posts, or whose history it reads. */
export const workflowChannelSchema = z.object({
  /** The Channel's ID. */
  id: z.int(),
  integrationKind: z.enum(INTEGRATION_KINDS),
  /** Its address, as `pero channels ls` shows it. */
  key: z.string(),
  title: z.string().nullable(),
});

export type WorkflowChannelView = z.infer<typeof workflowChannelSchema>;

/** A Channel a Notification goes to. */
export const notificationTargetSchema = workflowChannelSchema;

export type NotificationTargetView = WorkflowChannelView;

/** A schedule a Workflow runs on by itself, with where it stands. */
export const workflowScheduleSchema = z.object({
  cron: z.string(),
  /** The IANA time zone it follows. */
  timezone: z.string(),
  /** When it is next due; null until Pero schedules it, or if it never is. */
  nextRunAt: z.iso.datetime().nullable(),
  /** When it last queued a run; null if it never has. */
  lastRunAt: z.iso.datetime().nullable(),
});

export type WorkflowScheduleView = z.infer<typeof workflowScheduleSchema>;

/** A Workflow as `pero workflows ls` and `show` show it. */
export const workflowViewSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  /**
   * Its note, relative to the workspace when inside it; null in a legacy
   * data directory.
   */
  file: z.string().nullable(),
  /** The name of the Agent its runs use. */
  agent: z.string(),
  agentEnabled: z.boolean(),
  /** The input each run sends to the Agent. */
  inputTemplate: z.string(),
  /** False stops it running by itself; it still runs by hand. */
  enabled: z.boolean(),
  /** How many times a run may start in all. */
  maxAttempts: z.int(),
  /** When it runs by itself; empty when it runs only by hand. */
  schedules: z.array(workflowScheduleSchema),
  /** Where each run's answer is posted, by ID. */
  channels: z.array(workflowChannelSchema),
  /** The Channel history its runs read; null when they read none. */
  history: z
    .object({
      channels: z.union([z.literal('all'), z.array(workflowChannelSchema)]),
      messages: z.enum(HISTORY_MESSAGES),
      /** A fixed window in hours; null reads since the previous run. */
      hours: z.int().nullable(),
      runWhenEmpty: z.boolean(),
    })
    .nullable(),
  /**
   * Its note's errors, for which its last good version is in use; empty in
   * a legacy data directory.
   */
  errors: z.array(
    z.object({ property: z.string().nullable(), message: z.string() }),
  ),
});

export type WorkflowView = z.infer<typeof workflowViewSchema>;

/** Statuses a Workflow Run does not leave. */
export const FINISHED_RUN_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const satisfies readonly (typeof RUN_STATUSES)[number][];

/** One execution of a Workflow. */
export const runViewSchema = z.object({
  id: z.int(),
  /** The name of the Workflow it runs. */
  workflow: z.string(),
  /** The Trigger that started it; null once that Trigger is removed. */
  triggerId: z.int().nullable(),
  triggerKey: z.string(),
  status: z.enum(RUN_STATUSES),
  attempt: z.int(),
  /** Later times of its schedule that came due and were coalesced into it. */
  skippedCount: z.int(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** What the Agent answered; null until it completes. */
  result: z.string().nullable(),
  /**
   * Completed without its Agent, since its history window had no
   * messages; `result` is then null.
   */
  skipped: z.boolean(),
  /** Why it did not complete; null otherwise. */
  error: z.string().nullable(),
});

export type RunView = z.infer<typeof runViewSchema>;

const runIdSchema = z.int().positive();

/** The most runs or Notifications a list returns at once. */
export const MAX_LISTED = 500;

export const DEFAULT_LISTED = 20;

const listLimitSchema = z.int().min(1).max(MAX_LISTED).default(DEFAULT_LISTED);

/** A durable message a finished run leaves for a Channel. */
export const notificationViewSchema = z.object({
  id: z.int(),
  /** The run that left it. */
  runId: z.int(),
  /** The name of that run's Workflow. */
  workflow: z.string(),
  /** Where it goes. */
  channel: notificationTargetSchema,
  status: z.enum(NOTIFICATION_STATUSES),
  /** Delivery attempts made so far. */
  attempt: z.int(),
  /** Attempts it gets before it is `failed`. */
  maxAttempts: z.int(),
  /** When a pending one is tried next; null otherwise. */
  nextAttemptAt: z.iso.datetime().nullable(),
  /** Why the latest attempt failed; null once delivered or before trying. */
  lastError: z.string().nullable(),
  /** The delivered message's ID in its integration; null until then. */
  providerMessageId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type NotificationView = z.infer<typeof notificationViewSchema>;

export const notificationDetailsSchema = notificationViewSchema.extend({
  /** The message it delivers; null when its payload holds none. */
  text: z.string().nullable(),
  /**
   * Whether its Channel's chat is allowed now; null while the Channel's
   * integration is not connected, so it cannot tell.
   */
  chatAllowed: z.boolean().nullable(),
  /**
   * Why its Channel's integration is not ready, as `pero status` shows it;
   * null while it is.
   */
  integrationProblem: z.string().nullable(),
  /** Whether an attempt to deliver it is under way. */
  delivering: z.boolean(),
});

export type NotificationDetails = z.infer<typeof notificationDetailsSchema>;

/** A run with what it read and whom it told. */
export const runDetailsSchema = runViewSchema.extend({
  /** The run that retries it; null when none does. */
  retriedBy: z.int().nullable(),
  /** The Channel history it read; null when it read none, or not yet. */
  history: z
    .object({
      channels: z.union([z.literal('all'), z.array(z.int())]),
      messages: z.enum(HISTORY_MESSAGES),
      /** How many messages its window held. */
      count: z.int(),
      /** How many of the oldest its input left out to fit its budget. */
      dropped: z.int(),
    })
    .nullable(),
  /** Oldest first. */
  notifications: z.array(notificationViewSchema),
});

export type RunDetails = z.infer<typeof runDetailsSchema>;

const notificationIdSchema = z.int().positive();

/** What `pero check` found in the workspace; see `WorkspaceCheck`. */
export const workspaceCheckSchema = z.object({
  settingsFolder: z.string().nullable(),
  agents: z.int().nonnegative(),
  workflows: z.int().nonnegative(),
  topicsChecked: z.boolean(),
  problems: z.array(
    z.object({
      file: z.string(),
      property: z.string().nullable(),
      message: z.string(),
    }),
  ),
});

const noParams = z.strictObject({});

// Results are plain objects, not strict ones: a newer daemon may add fields
// that an older CLI does not know yet.
/** Every operation with its parameter and result schemas. */
export const CONTROL_OPERATIONS = {
  status: { params: noParams, result: statusResultSchema },
  shutdown: { params: noParams, result: z.object({}) },
  /** `pero check`, with topic titles checked against the topics seen. */
  check: { params: noParams, result: workspaceCheckSchema },
  'settings.get': { params: noParams, result: settingsViewSchema },
  'settings.update': {
    params: settingsChangeSchema,
    result: settingsViewSchema,
  },
  /** Checks each provider's sign-in again, then reports status. */
  'providers.check': { params: noParams, result: statusResultSchema },
  /** Allowed Telegram chats and the chats that recently asked to pair. */
  'telegram.chats': { params: noParams, result: telegramChatsSchema },
  'telegram.allow': {
    params: z.strictObject({ chatId: telegramChatIdSchema }),
    result: z.object({
      chat: allowedChatSchema,
      alreadyAllowed: z.boolean(),
    }),
  },
  /** Keeps the chat's Channels and Agents for when it is allowed again. */
  'telegram.deny': {
    params: z.strictObject({ chatId: telegramChatIdSchema }),
    result: z.object({ chat: allowedChatSchema }),
  },
  /** Every Agent, by name. */
  'agents.list': {
    params: noParams,
    result: z.object({ agents: z.array(agentViewSchema) }),
  },
  'agents.get': {
    params: z.strictObject({ name: agentNameSchema }),
    result: agentDetailsSchema,
  },
  /** Every Channel, by ID. */
  'channels.list': {
    params: noParams,
    result: z.object({ channels: z.array(channelViewSchema) }),
  },
  'channels.get': {
    params: z.strictObject({ id: channelIdSchema }),
    result: channelDetailsSchema,
  },
  /** The Channel's latest messages, oldest first. */
  'channels.history': {
    params: z.strictObject({
      id: channelIdSchema,
      limit: z
        .int()
        .min(1)
        .max(MAX_HISTORY_MESSAGES)
        .default(DEFAULT_HISTORY_MESSAGES),
    }),
    result: z.object({
      channel: channelViewSchema,
      messages: z.array(historyMessageSchema),
    }),
  },
  /** Every Workflow, by name. */
  'workflows.list': {
    params: noParams,
    result: z.object({ workflows: z.array(workflowViewSchema) }),
  },
  'workflows.get': {
    params: z.strictObject({ name: workflowReferenceSchema }),
    result: workflowViewSchema,
  },
  /**
   * Queues a run of a Workflow, whatever its `trigger`; the executor
   * starts it once a slot is free.
   */
  'workflows.run': {
    params: z.strictObject({ name: workflowReferenceSchema }),
    result: runViewSchema,
  },
  /** The latest runs, newest first. */
  'runs.list': {
    params: z.strictObject({
      workflow: workflowReferenceSchema.optional(),
      status: z.enum(RUN_STATUSES).optional(),
      limit: listLimitSchema,
    }),
    result: z.object({ runs: z.array(runViewSchema) }),
  },
  'runs.get': {
    params: z.strictObject({ id: runIdSchema }),
    result: runDetailsSchema,
  },
  /**
   * Queues a failed, interrupted, or cancelled run again as a new run that
   * reads the same history window, whatever its Workflow's attempts allow.
   * `alsoReadBy` names a run completed since that read some of those
   * messages too; null when none did.
   */
  'runs.retry': {
    params: z.strictObject({ id: runIdSchema }),
    result: z.object({
      run: runViewSchema,
      alsoReadBy: z.int().nullable(),
    }),
  },
  /**
   * Cancels a pending run at once, or aborts a running one, which is
   * returned still `running` until its turn stops.
   */
  'runs.cancel': {
    params: z.strictObject({ id: runIdSchema }),
    result: runViewSchema,
  },
  /** The latest Notifications, newest first. */
  'notifications.list': {
    params: z.strictObject({
      status: z.enum(NOTIFICATION_STATUSES).optional(),
      workflow: workflowReferenceSchema.optional(),
      channel: channelIdSchema.optional(),
      run: runIdSchema.optional(),
      limit: listLimitSchema,
    }),
    result: z.object({ notifications: z.array(notificationViewSchema) }),
  },
  'notifications.get': {
    params: z.strictObject({ id: notificationIdSchema }),
    result: notificationDetailsSchema,
  },
  /**
   * Makes a pending Notification due now, or gives a failed one a fresh
   * set of attempts starting now; a delivered one is refused.
   */
  'notifications.retry': {
    params: z.strictObject({ id: notificationIdSchema }),
    result: notificationDetailsSchema,
  },
  /**
   * Writes a backup of the data directory to an absolute path, with the
   * data folder when `includeData` is set.
   */
  'backup.create': {
    params: z.strictObject({
      file: z.string().min(1),
      includeData: z.boolean().optional(),
    }),
    result: backupResultSchema,
  },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type ControlOperation = keyof typeof CONTROL_OPERATIONS;

export type ControlParams<Op extends ControlOperation> = z.input<
  (typeof CONTROL_OPERATIONS)[Op]['params']
>;

/** An operation's parameters once validated, with defaults filled in. */
export type ParsedControlParams<Op extends ControlOperation> = z.output<
  (typeof CONTROL_OPERATIONS)[Op]['params']
>;

export type ControlResult<Op extends ControlOperation> = z.output<
  (typeof CONTROL_OPERATIONS)[Op]['result']
>;

export function isControlOperation(op: string): op is ControlOperation {
  return Object.hasOwn(CONTROL_OPERATIONS, op);
}

export const controlRequestSchema = z.object({
  op: z.string(),
  params: z.unknown().optional(),
});

export type ControlRequest = z.infer<typeof controlRequestSchema>;

/**
 * Codes the daemon answers with. The client also raises `timeout`,
 * `connection`, `invalid_response`, and `too_large`.
 */
export const CONTROL_ERROR_CODES = [
  'invalid_request',
  'unknown_operation',
  'invalid_input',
  'not_found',
  'conflict',
  'internal',
] as const;

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

// The error code stays a plain string so an older CLI can still report a
// code that a newer daemon added.
export const controlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type ControlResponse = z.infer<typeof controlResponseSchema>;

/** A control request that failed for a reason other than its input. */
export class ControlError extends Error {
  override name = 'ControlError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Resolves with the first line `socket` receives, without its newline.
 * Rejects with a `too_large` `ControlError` past `maxBytes`, and when the
 * connection ends or fails first. Anything after the line is ignored.
 */
export function readLine(
  socket: Socket,
  maxBytes = MAX_MESSAGE_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      size += part.length;
      if (size > maxBytes) {
        cleanup();
        reject(
          new ControlError('too_large', `Message exceeds ${maxBytes} bytes`),
        );
        return;
      }
      chunks.push(part);
      if (newline !== -1) {
        cleanup();
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(
        new ControlError(
          'connection',
          'Connection closed before a complete message',
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
  });
}
