import { mkdirSync } from 'node:fs';
import { InvalidInputError, NotFoundError } from '../common/errors.js';
import type { DataDirLayout } from '../config/data-dir.js';
import {
  allowChat,
  chatKindOf,
  defaultHostConfig,
  denyChat,
  editHostConfig,
  readHostConfig,
  telegramChatIdSchema,
} from '../config/host-config.js';
import type { AllowedChatView } from '../control/protocol.js';

/*
 * `pero telegram allow` and `deny` while Pero is stopped: they edit
 * `config.yaml` themselves, keeping its comments, and Pero serves the new
 * list from its next start.
 */

/** Adds chat `chatId` to `config.yaml`, creating the file if needed. */
export function allowInFile(
  layout: DataDirLayout,
  chatId: string,
): { chat: AllowedChatView; alreadyAllowed: boolean } {
  const chatKey = checkChatId(chatId);
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  let added = false;
  const config = editHostConfig(
    layout.configFile,
    (document) => {
      added = allowChat(document, chatKey, null);
    },
    () => defaultHostConfig(layout.workspace === null ? { data: null } : {}),
  );
  const entry = config.allowedChats.find((chat) => chat.chatKey === chatKey);
  return { chat: view(chatKey, entry?.title ?? null), alreadyAllowed: !added };
}

/** Removes chat `chatId` from `config.yaml`; throws when it isn't there. */
export function denyInFile(
  layout: DataDirLayout,
  chatId: string,
): { chat: AllowedChatView } {
  const chatKey = checkChatId(chatId);
  const entry = readHostConfig(layout.configFile)?.allowedChats.find(
    (chat) => chat.chatKey === chatKey,
  );
  if (entry === undefined) {
    throw new NotFoundError(`Telegram chat ${chatKey} is not allowed`);
  }
  editHostConfig(layout.configFile, (document) => {
    denyChat(document, chatKey);
  });
  return { chat: view(chatKey, entry.title) };
}

function checkChatId(chatId: string): string {
  const parsed = telegramChatIdSchema.safeParse(chatId);
  if (!parsed.success) {
    throw new InvalidInputError(`chat-id: ${parsed.error.issues[0]!.message}`);
  }
  return parsed.data;
}

/** What the CLI knows of a chat without Telegram: its ID and label. */
function view(chatKey: string, title: string | null): AllowedChatView {
  return {
    chatId: chatKey,
    kind: chatKindOf(chatKey),
    title,
    bot: null,
    topics: null,
    problem: null,
  };
}
