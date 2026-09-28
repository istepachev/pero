import type { Socket } from 'node:net';
import { z } from 'zod';
import {
  PROVIDERS,
  providerDefaultsSchema,
} from '../config/provider-options.js';
import { settingsChangeSchema } from '../config/settings-input.js';
import { CHAT_KINDS } from '../persistence/entities/sql.js';

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
  dataDir: z.string(),
  /** When the daemon became ready. */
  startedAt: z.iso.datetime(),
  uptimeMs: z.int().nonnegative(),
  /** `degraded` when any component is not `ok`. */
  health: z.enum(['ok', 'degraded']),
  components: z.array(componentStatusSchema),
});

export type StatusResult = z.infer<typeof statusResultSchema>;

export const TOKEN_SOURCES = ['environment', 'secrets'] as const;

export type TokenSource = (typeof TOKEN_SOURCES)[number];

/** Installation settings as the CLI sees them; secrets only as set or not. */
export const settingsViewSchema = z.object({
  defaultProvider: z.enum(PROVIDERS),
  providerDefaults: providerDefaultsSchema,
  defaultWorkingDirectory: z.string().nullable(),
  sharedInstructions: z.string().nullable(),
  historyCarryover: z.int(),
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
});

export type SettingsView = z.infer<typeof settingsViewSchema>;

export const backupResultSchema = z.object({
  /** Absolute path of the written archive. */
  file: z.string(),
  createdAt: z.iso.datetime(),
  bytes: z.int().nonnegative(),
  /** Whether the archive holds stored secrets such as the bot token. */
  includesSecrets: z.boolean(),
});

export type BackupResult = z.infer<typeof backupResultSchema>;

/** A Telegram chat ID: negative for a group, the user's ID for a direct chat. */
export const telegramChatIdSchema = z
  .string()
  .trim()
  .regex(
    /^-?\d{1,20}$/,
    'must be a Telegram chat ID, such as -1001234567890 or 123456789',
  );

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
  allowedAt: z.iso.datetime(),
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

const noParams = z.strictObject({});

// Results are plain objects, not strict ones: a newer daemon may add fields
// that an older CLI does not know yet.
/** Every operation with its parameter and result schemas. */
export const CONTROL_OPERATIONS = {
  status: { params: noParams, result: statusResultSchema },
  shutdown: { params: noParams, result: z.object({}) },
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
  /** Writes a backup of the data directory to an absolute path. */
  'backup.create': {
    params: z.strictObject({ file: z.string().min(1) }),
    result: backupResultSchema,
  },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type ControlOperation = keyof typeof CONTROL_OPERATIONS;

export type ControlParams<Op extends ControlOperation> = z.input<
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
