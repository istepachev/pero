import { PROVIDERS } from '../../config/provider-options.js';
import { TELEGRAM_TOKEN_ENV } from '../../config/settings-input.js';
import type { ControlClient } from '../../control/client.js';
import {
  ControlError,
  type SettingsView,
  type StatusResult,
  type TelegramChats,
} from '../../control/protocol.js';
import { describe, needsAdmin } from '../format-telegram-chats.js';

/** Something the owner still has to set up, and how. */
export interface PendingSetup {
  name: string;
  /** One line: what is missing, then the command that fixes it. */
  message: string;
}

/**
 * What stands between the daemon and a working installation: the Telegram
 * bot token, a Telegram chat to serve, the bot as an administrator of each
 * allowed group, each such group private, and sign-in for each provider in use. Providers
 * no Agent uses are left out. Without `chats`, as from a daemon too old
 * to list them, the chat is too.
 */
export function pendingSetup(
  status: StatusResult,
  settings: SettingsView,
  chats: TelegramChats | null = null,
): PendingSetup[] {
  const pending: PendingSetup[] = [];
  const component = (name: string) =>
    status.components.find((candidate) => candidate.name === name);
  // Only a missing or rejected token needs setup; a connection that is
  // still starting or failing for a while shows in `pero status`.
  const telegram = component('telegram');
  if (
    telegram &&
    (!settings.telegramBotToken.set || telegram.state === 'unconfigured')
  ) {
    pending.push({
      name: 'telegram',
      message:
        settings.telegramBotToken.source === 'environment'
          ? `Telegram: ${telegram.detail} — start Pero with a valid ${TELEGRAM_TOKEN_ENV}`
          : `Telegram: ${telegram.detail ?? 'not set up'} — pero telegram token (reads it from stdin), or start Pero with ${TELEGRAM_TOKEN_ENV}`,
    });
  } else if (telegram && chats !== null && chats.allowed.length === 0) {
    const request = chats.pairing[0];
    pending.push({
      name: 'telegram-chat',
      message:
        request === undefined
          ? 'Telegram: no chat is allowed yet — add the bot to a group as an administrator or message it, then pero telegram allow <chat-id>'
          : `Telegram: no chat is allowed yet — pero telegram allow ${request.chatId} allows the ${describe(request)} that asked to pair`,
    });
  } else if (telegram && chats !== null) {
    for (const chat of chats.allowed) {
      if (needsAdmin(chat)) {
        pending.push({
          name: 'telegram-admin',
          message: `Telegram: the bot is not an administrator of ${describe(chat)} — make it one in the group's settings`,
        });
      }
      if (chat.danger !== null) {
        pending.push({
          name: 'telegram-public',
          message: `Telegram: ${describe(chat)} is public, so anyone can join it and talk to its Agents — make it private in the group's settings, or pero telegram deny ${chat.chatId}`,
        });
      }
    }
  }

  for (const provider of PROVIDERS) {
    const state = component(provider);
    if (!state || !state.required || state.state === 'ok') continue;
    pending.push({
      name: provider,
      message: `${provider}: ${state.detail ?? state.state}, then pero run to check again`,
    });
  }
  return pending;
}

/** `pending` as `pero run` prints it, followed by `hint`. */
export function formatPendingSetup(
  pending: PendingSetup[],
  hint = 'Run pero run in a terminal to set these up step by step.',
): string {
  return [
    'Setup needed:',
    ...pending.map((item) => `  ${item.message}`),
    hint,
  ].join('\n');
}

/** The daemon's Telegram chats; null when it is too old to list them. */
export async function fetchTelegramChats(
  client: ControlClient,
): Promise<TelegramChats | null> {
  try {
    return await client.call('telegram.chats');
  } catch (error) {
    if (error instanceof ControlError && error.code === 'unknown_operation') {
      return null;
    }
    throw error;
  }
}
