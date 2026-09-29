import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-file.js';
import { ConfigError, resolvePath } from './bootstrap-config.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * `config.yaml` holds what describes this installation and that an Agent
 * working in the data folder must not change: where the data folder is, and
 * which chats Pero serves. It lives in the state directory (a workspace's
 * `.pero/`, or a legacy data directory) and is meant to be committed.
 */

/** The file's name inside the state directory. */
export const HOST_CONFIG_FILE = 'config.yaml';

/** The data folder of a workspace whose `config.yaml` names none. */
export const DEFAULT_DATA_FOLDER = 'data';

/**
 * A Telegram chat ID: negative for a group, the user's ID for a direct
 * chat. Kept as a string, since it may exceed 2^53.
 */
export const telegramChatIdSchema = z
  .string()
  .trim()
  .regex(
    /^-?\d{1,20}$/,
    'must be a Telegram chat ID, such as -1001234567890 or 123456789',
  );

/** Groups have negative Telegram IDs; people, positive ones. */
export function chatKindOf(chatKey: string): 'group' | 'private' {
  return chatKey.startsWith('-') ? 'group' : 'private';
}

/** A chat in `telegram.allowed-chats`. */
export interface HostAllowedChat {
  chatKey: string;
  /** The owner's own label; Pero doesn't use it to find the chat. */
  title: string | null;
}

/** `config.yaml` as Pero uses it. */
export interface HostConfig {
  /** `data` as written; null when the file doesn't set it. */
  data: string | null;
  /** `settings` as written; null when the file doesn't set it. */
  settings: string | null;
  allowedChats: HostAllowedChat[];
}

const EMPTY: HostConfig = { data: null, settings: null, allowedChats: [] };

const folder = z
  .string({ error: 'must be a folder path' })
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => !value.includes('\0'), 'must not contain a NUL byte');

// YAML integers arrive as bigints, so large IDs keep every digit.
const chatId = z
  .union([z.bigint(), z.string()], {
    error: 'must be a Telegram chat ID, such as -1001234567890 or 123456789',
  })
  .transform(String)
  .pipe(telegramChatIdSchema);

const schema = z.strictObject({
  data: folder.nullish(),
  settings: folder.nullish(),
  telegram: z
    .strictObject({
      'allowed-chats': z
        .array(
          z.strictObject({
            id: chatId,
            title: z.string({ error: 'must be text' }).nullish(),
          }),
          { error: 'must be a list of chats, each with an id' },
        )
        .nullish()
        .superRefine((chats, ctx) => {
          const seen = new Set<string>();
          chats?.forEach((chat, index) => {
            if (seen.has(chat.id)) {
              ctx.addIssue({
                code: 'custom',
                path: [index, 'id'],
                message: `${chat.id} is listed twice`,
              });
            }
            seen.add(chat.id);
          });
        }),
    })
    .nullish(),
});

const PARSE_OPTIONS = {
  version: '1.2',
  schema: 'core',
  uniqueKeys: true,
  intAsBigInt: true,
  prettyErrors: false,
} as const;

/**
 * Parses `text`, the `config.yaml` at `file`. Throws a `ConfigError`
 * naming the file, the line, the key, and what is wrong.
 */
export function parseHostConfig(file: string, text: string): HostConfig {
  return check(file, parse(text)).config;
}

/** The `config.yaml` at `path`; null when there is none. */
export function readHostConfig(path: string): HostConfig | null {
  const text = readText(path);
  return text === null ? null : parseHostConfig(path, text);
}

/**
 * Changes the `config.yaml` at `path` with `edit`, keeping its comments,
 * ordering, and everything `edit` leaves alone, and returns the new
 * contents. The file is read again right before the change, so edits made
 * by hand meanwhile are kept, and replaced in one step. A missing file
 * starts from `template`. An invalid file is not changed: that throws.
 */
export function editHostConfig(
  path: string,
  edit: (document: Document) => void,
  template: () => string = () => defaultHostConfig(),
): HostConfig {
  const text = readText(path);
  const { document } = check(path, parse(text ?? template()));
  edit(document);
  const updated = document.toString();
  const { config } = check(path, parse(updated));
  writeFileAtomic(path, updated, text === null ? 0o644 : modeOf(path));
  return config;
}

/**
 * Adds chat `chatKey` to the allowed chats, with `title` as its label.
 * A chat already there keeps its entry, gaining a label if it had none.
 * False when nothing changed.
 */
export function allowChat(
  document: Document,
  chatKey: string,
  title: string | null,
): boolean {
  const chats = allowedChatsNode(document);
  const existing = chats.items.find(
    (item) => isMap(item) && idOf(item) === chatKey,
  ) as YAMLMap | undefined;
  if (existing) {
    if (title === null || existing.has('title')) return false;
    existing.set('title', title);
    return true;
  }
  chats.flow = false;
  const entry = document.createNode(
    title === null ? { id: BigInt(chatKey) } : { id: BigInt(chatKey), title },
  );
  chats.add(entry);
  return true;
}

/** Removes chat `chatKey` from the allowed chats; false when it wasn't there. */
export function denyChat(document: Document, chatKey: string): boolean {
  const chats = document.getIn(['telegram', 'allowed-chats'], true);
  if (!isSeq(chats)) return false;
  const before = chats.items.length;
  chats.items = chats.items.filter(
    (item) => !(isMap(item) && idOf(item) === chatKey),
  );
  return chats.items.length !== before;
}

/**
 * Follows chat `from` to its new ID `to`, as when a group turns on topics:
 * its entry gets the new ID, or goes when `to` is already allowed. False
 * when `from` wasn't allowed.
 */
export function moveChatId(
  document: Document,
  from: string,
  to: string,
): boolean {
  const chats = document.getIn(['telegram', 'allowed-chats'], true);
  if (!isSeq(chats)) return false;
  const entry = chats.items.find(
    (item) => isMap(item) && idOf(item) === from,
  ) as YAMLMap | undefined;
  if (!entry) return false;
  if (chats.items.some((item) => isMap(item) && idOf(item) === to)) {
    return denyChat(document, from);
  }
  const id = entry.get('id', true);
  if (isScalar(id)) id.value = BigInt(to);
  else entry.set('id', BigInt(to));
  return true;
}

/** Sets `data`, keeping the comments around it. */
export function setDataFolder(document: Document, value: string): void {
  document.set('data', value);
}

/**
 * The commented `config.yaml` a new installation starts with. `data` is
 * the data folder to write; null leaves it commented out, as for a legacy
 * data directory without a default working directory.
 */
export function defaultHostConfig(
  options: { data?: string | null } = {},
): string {
  const data = options.data === undefined ? DEFAULT_DATA_FOLDER : options.data;
  return [
    "# Pero's host settings: where the data folder is and which chats Pero",
    '# serves. Commit this file; the bot token belongs in .env, never here.',
    '',
    '# Data folder: the vault Agents work in. Relative to the workspace.',
    '# Changing it takes a restart.',
    data === null ? '# data: data' : `data: ${quoteScalar(data)}`,
    '',
    '# Settings folder. Relative to the workspace. Default: <data>/Settings',
    '# settings: data/Settings',
    '',
    'telegram:',
    '  # The chats Pero serves. Anyone who can post in an allowed group',
    '  # reaches its Agents. Add one with pero telegram allow <chat-id>,',
    '  # or here:',
    '  #   - id: -1001234567890   # a group; negative',
    "  #     title: Home          # for you; Pero doesn't use it",
    '  #   - id: 123456789        # a direct chat: your user ID',
    '  allowed-chats: []',
    '',
  ].join('\n');
}

/**
 * The data folder `config` names, as an absolute path. A relative path is
 * taken from `base`: the workspace, or a legacy data directory. Without
 * `data`, a workspace uses its `data/` folder and a legacy data directory
 * has none (null).
 */
export function resolveDataFolder(
  config: Pick<HostConfig, 'data'>,
  base: string,
  workspace: boolean,
  home: string = homedir(),
): string | null {
  const data = config.data ?? (workspace ? DEFAULT_DATA_FOLDER : null);
  return data === null ? null : resolvePath(data, base, home);
}

/**
 * How to write data folder `folder` (absolute) in `config.yaml`: relative
 * to the workspace when it is inside it, so a cloned workspace keeps
 * working; absolute otherwise, and always in a legacy data directory.
 */
export function dataFolderValue(
  folder: string,
  workspace: string | null,
): string {
  if (workspace === null) return folder;
  const inside = relative(workspace, folder);
  if (inside === '') return '.';
  if (inside.startsWith('..') || isAbsolute(inside)) return folder;
  return inside;
}

/** `config.yaml` in state directory `root`. */
export function hostConfigPath(root: string): string {
  return join(root, HOST_CONFIG_FILE);
}

interface Parsed {
  document: Document;
  lineCounter: LineCounter;
}

function parse(text: string): Parsed {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { ...PARSE_OPTIONS, lineCounter });
  return { document, lineCounter };
}

function check(
  file: string,
  { document, lineCounter }: Parsed,
): { document: Document; config: HostConfig } {
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) {
    const lines = problems.map((problem) => {
      const { line } = lineCounter.linePos(problem.pos[0]);
      const message = problem.message.split('\n')[0]!.replace(/[.:]$/, '');
      return `  line ${line}: ${message}`;
    });
    throw new ConfigError(`Invalid ${file}:\n${lines.join('\n')}`);
  }

  const value: unknown = document.toJS() ?? {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `Invalid ${file}:\n  must be "key: value" lines, such as data: data`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const lines = parsed.error.issues.flatMap((issue) => {
      const keys =
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => [...issue.path, key])
          : [issue.path];
      return keys.map((path) => {
        const line = lineOf(document, lineCounter, path);
        const where = line === null ? '' : `line ${line}: `;
        const message =
          issue.code === 'unrecognized_keys' ? 'unknown key' : issue.message;
        return `  ${where}${keyPath(path)}: ${message}`;
      });
    });
    throw new ConfigError(`Invalid ${file}:\n${lines.join('\n')}`);
  }

  const { data, settings, telegram } = parsed.data;
  return {
    document,
    config: {
      ...EMPTY,
      data: data ?? null,
      settings: settings ?? null,
      allowedChats: (telegram?.['allowed-chats'] ?? []).map((chat) => ({
        chatKey: chat.id,
        title: chat.title ?? null,
      })),
    },
  };
}

/** `telegram.allowed-chats (item 2).id`, counting items from 1. */
function keyPath(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) =>
      typeof key === 'number'
        ? ` (item ${key + 1})`
        : `${index === 0 ? '' : '.'}${String(key)}`,
    )
    .join('')
    .replace(/\. \(/g, ' (');
}

/** The line of the node at `path`, counting from 1; null when unknown. */
function lineOf(
  document: Document,
  lineCounter: LineCounter,
  path: readonly PropertyKey[],
): number | null {
  for (let length = path.length; length > 0; length--) {
    const node = document.getIn(path.slice(0, length) as unknown[], true) as
      { range?: [number, number, number] } | undefined;
    const start = node?.range?.[0];
    if (start !== undefined) return lineCounter.linePos(start).line;
  }
  return null;
}

/** The allowed-chats list, created as a block list when missing. */
function allowedChatsNode(document: Document): YAMLSeq {
  if (!isMap(document.get('telegram', true))) {
    document.set('telegram', document.createNode({}));
  }
  const telegram = document.get('telegram', true) as YAMLMap;
  const existing: unknown = telegram.get('allowed-chats', true);
  if (isSeq(existing)) return existing;
  const chats = document.createNode([]) as YAMLSeq;
  telegram.set('allowed-chats', chats);
  return chats;
}

function idOf(entry: YAMLMap): string | null {
  const id: unknown = entry.get('id');
  return typeof id === 'bigint' || typeof id === 'string' ? String(id) : null;
}

function quoteScalar(value: string): string {
  return /^[\w./~-]+$/.test(value) ? value : JSON.stringify(value);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o644;
  }
}
