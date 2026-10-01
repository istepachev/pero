import type {
  AllowedChatView,
  PairingRequestView,
  TelegramChats,
} from '../control/protocol.js';
import { formatDuration, table } from './format-status.js';

/** How to get a chat to ask to pair; `bot` is the bot's username. */
export function pairingSteps(bot: string | null): string[] {
  const name = botName(bot);
  return [
    `Create a private group (recommended), turn on Topics in its settings, and add ${name} as an administrator;`,
    `or send ${name} a direct message.`,
  ];
}

/**
 * Whether the bot is known to be in group `chat` without administrator
 * rights, or not to be there at all; false while unchecked.
 */
export function needsAdmin(chat: AllowedChatView): boolean {
  return (
    chat.kind === 'group' && (chat.bot === 'member' || chat.bot === 'left')
  );
}

function botName(bot: string | null): string {
  return bot === null ? 'the bot' : `@${bot}`;
}

/** `pero telegram chats` output. */
export function formatTelegramChats(
  chats: TelegramChats,
  now = new Date(),
): string {
  const lines = [
    chats.bot === null
      ? 'Bot: not connected (see pero status)'
      : `Bot: @${chats.bot}`,
    '',
  ];
  if (chats.allowed.length === 0) {
    lines.push(
      'No chat is allowed yet. To pair one:',
      ...pairingSteps(chats.bot).map((step) => `  ${step}`),
      `  ${chats.bot === null ? 'The bot' : `@${chats.bot}`} answers a chat it does not serve with that chat's ID; allow it with pero telegram allow <chat-id>.`,
    );
  } else {
    lines.push(
      'Allowed chats',
      ...table([
        ['ID', 'KIND', 'TITLE', 'TOPICS', 'BOT'],
        ...chats.allowed.map((chat) => [
          chat.chatId,
          chat.kind,
          chat.title ?? '—',
          topics(chat),
          membership(chat),
        ]),
      ]).map((row) => `  ${row}`),
    );
    const problems = chats.allowed.flatMap((chat) => warnings(chat));
    if (problems.length > 0) lines.push('', ...problems);
  }
  if (chats.pairing.length > 0) {
    lines.push(
      '',
      'Asked to pair',
      ...table([
        ['ID', 'KIND', 'TITLE', 'LAST SEEN'],
        ...chats.pairing.map((request) => [
          request.chatId,
          request.kind,
          request.title ?? '—',
          lastSeen(request, now),
        ]),
      ]).map((row) => `  ${row}`),
      'Allow one with pero telegram allow <chat-id>',
    );
  }
  return lines.join('\n');
}

/** What `pero telegram allow` says about the chat it allowed. */
export function formatAllowed(
  chat: AllowedChatView,
  alreadyAllowed: boolean,
): string {
  const lines = [
    `${alreadyAllowed ? 'Already allowed' : 'Allowed'}: ${describe(chat)}`,
  ];
  if (chat.kind === 'group') {
    lines.push(...warnings(chat));
    if (chat.problem === null && chat.bot === null) {
      lines.push(
        'Make sure the bot is an administrator there, or Telegram shows it only commands, mentions, and replies.',
      );
    }
    if (chat.topics !== true) {
      lines.push(
        'Turn on Topics in the group settings to give each Agent its own topic; Pero follows the new chat ID this gives the group.',
      );
    }
  }
  return lines.join('\n');
}

/** What is wrong with allowed chat `chat`, gravest first. */
function warnings(chat: AllowedChatView): string[] {
  return [
    ...(chat.danger === null ? [] : [`Danger: ${chat.danger}`]),
    ...(chat.problem === null ? [] : [`Warning: ${chat.problem}`]),
  ];
}

/** A chat as `pero telegram` names it: kind, title, and ID. */
export function describe(chat: {
  chatId: string;
  kind: AllowedChatView['kind'];
  title: string | null;
}): string {
  const kind = chat.kind === 'group' ? 'group' : 'direct chat';
  return chat.title === null
    ? `${kind} ${chat.chatId}`
    : `${kind} "${chat.title}" (${chat.chatId})`;
}

function topics(chat: AllowedChatView): string {
  if (chat.kind === 'private') return '—';
  if (chat.topics === null) return '?';
  return chat.topics ? 'on' : 'off';
}

function membership(chat: AllowedChatView): string {
  if (chat.kind === 'private') return '—';
  switch (chat.bot) {
    case null:
      return 'not checked';
    case 'member':
      return chat.problem === null ? 'member' : 'member, not an administrator';
    case 'left':
      return 'not in the group';
    default:
      return chat.bot;
  }
}

function lastSeen(request: PairingRequestView, now: Date): string {
  const ms = now.getTime() - Date.parse(request.lastSeenAt);
  return `${formatDuration(Math.max(0, ms))} ago`;
}
