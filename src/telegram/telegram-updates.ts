import type { Chat, ChatMember, Message, Update } from 'grammy/types';
import type {
  ChannelEvent,
  InboundChannel,
  InboundChat,
  InboundMessage,
} from '../channels/channel-adapter.js';
import type { ChatKind } from '../persistence/entities/sql.js';

/*
 * Telegram updates as the Channel contract's shapes. Pure, so every rule
 * about addresses and which messages count is tested without a bot.
 */

/** Telegram's stand-in sender for an anonymous group administrator. */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/** A Telegram chat as a Channel address; IDs are kept as strings. */
export interface TelegramAddress {
  chatId: string;
  /** The topic; absent for a chat's primary Channel. */
  messageThreadId?: string;
}

/** Where `address`, stored as a Channel's address JSON, points. */
export function parseAddress(
  address: Readonly<Record<string, unknown>>,
): TelegramAddress {
  const { chatId, messageThreadId } = address;
  if (typeof chatId !== 'string') {
    throw new Error('A Telegram address needs a chatId string');
  }
  if (messageThreadId !== undefined && typeof messageThreadId !== 'string') {
    throw new Error('A Telegram messageThreadId must be a string');
  }
  return messageThreadId === undefined
    ? { chatId }
    : { chatId, messageThreadId };
}

/** Of the bot's own details, what normalization needs. */
export interface BotIdentity {
  id: number;
}

/**
 * `update` as a message for an Agent or an event about a chat, or null when
 * Pero ignores it: another bot's message, a channel post, a service message
 * with no meaning here, or a message without text.
 */
export function toInbound(
  update: Update,
  me: BotIdentity,
): InboundMessage | ChannelEvent | null {
  // Update IDs count per bot, so a new token must not look like redelivery.
  const updateId = `${me.id}:${update.update_id}`;
  if (update.my_chat_member) {
    const { chat, new_chat_member } = update.my_chat_member;
    const inboundChat = toChat(chat);
    if (inboundChat === null) return null;
    return {
      type: 'membership-changed',
      integrationKind: 'telegram',
      updateId,
      chat: inboundChat,
      status: membershipStatus(new_chat_member),
    };
  }
  if (update.message) return fromMessage(update.message, updateId);
  return null;
}

function fromMessage(
  message: Message,
  updateId: string,
): InboundMessage | ChannelEvent | null {
  const chat = toChat(message.chat);
  if (chat === null) return null;
  const base = { integrationKind: 'telegram' as const, updateId, chat };

  if (message.migrate_to_chat_id !== undefined) {
    const newChatKey = String(message.migrate_to_chat_id);
    return {
      ...base,
      type: 'chat-migrated',
      newChatKey,
      newAddress: { chatId: newChatKey },
    };
  }
  if (message.migrate_from_chat_id !== undefined) {
    // Seen in the new chat: the old one, which the allowlist still names
    // unless the other half of the migration came first, moves here.
    const oldKey = String(message.migrate_from_chat_id);
    return {
      ...base,
      type: 'chat-migrated',
      chat: { ...chat, key: oldKey, address: { chatId: oldKey } },
      newChatKey: chat.key,
      newAddress: chat.address,
    };
  }
  if (message.forum_topic_created) {
    return {
      ...base,
      type: 'topic-created',
      channel: topicChannel(chat, message, message.forum_topic_created.name),
    };
  }
  if (message.forum_topic_edited) {
    const { name } = message.forum_topic_edited;
    // An edit that changes only the icon keeps the title.
    if (name === undefined) return null;
    return {
      ...base,
      type: 'topic-renamed',
      channel: topicChannel(chat, message, name),
    };
  }

  if (!fromPerson(message)) return null;
  const text = message.text ?? message.caption;
  // Attachments come later; a message without text has nothing to answer.
  if (text === undefined) return null;
  return {
    ...base,
    channel: channelOf(chat, message),
    messageId: String(message.message_id),
    senderId: String(message.sender_chat?.id ?? message.from?.id ?? ''),
    content: { text },
  };
}

/**
 * Whether a person wrote `message`. Other bots never reach an Agent, which
 * also stops two bots answering each other; an anonymous administrator of
 * the chat itself still counts as a person.
 */
function fromPerson(message: Message): boolean {
  // A channel's post that Telegram copies into its discussion group.
  if (message.is_automatic_forward) return false;
  const from = message.from;
  if (!from?.is_bot) return true;
  return (
    from.id === GROUP_ANONYMOUS_BOT_ID &&
    message.sender_chat?.id === message.chat.id
  );
}

/** The chat, or null for a Telegram channel, which Pero does not serve. */
function toChat(chat: Chat): InboundChat | null {
  const key = String(chat.id);
  const described = describeChat(chat);
  return described && { key, ...described, address: { chatId: key } };
}

/** The fields of a Telegram chat, or of `getChat`'s answer, Pero keeps. */
interface ChatFields {
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
}

/**
 * A chat's kind and title: a person's name for a direct chat. Null for a
 * Telegram channel, which Pero does not serve.
 */
export function describeChat(
  chat: ChatFields,
): { kind: ChatKind; title: string | null } | null {
  switch (chat.type) {
    case 'private':
      return {
        kind: 'private',
        title: [chat.first_name, chat.last_name].filter(Boolean).join(' '),
      };
    case 'group':
    case 'supergroup':
      return { kind: 'group', title: chat.title ?? null };
    default:
      return null;
  }
}

/**
 * The Channel `message` belongs to. A thread counts only in a forum topic;
 * in a group without topics it is a reply thread, which never splits a
 * Channel.
 */
function channelOf(chat: InboundChat, message: Message): InboundChannel {
  if (message.is_topic_message && message.message_thread_id !== undefined) {
    // Telegram attaches the topic's creation to messages in it when it can.
    const title = message.reply_to_message?.forum_topic_created?.name ?? null;
    return topicChannel(chat, message, title);
  }
  return {
    key: chat.key,
    title: chat.title,
    address: chat.address,
    topicId: null,
  };
}

function topicChannel(
  chat: InboundChat,
  message: Message,
  title: string | null,
): InboundChannel {
  // A topic's service messages have the topic's ID as their thread.
  const topicId = String(message.message_thread_id ?? message.message_id);
  return {
    key: `${chat.key}:${topicId}`,
    title,
    address: { chatId: chat.key, messageThreadId: topicId },
    topicId,
  };
}

/** The bot's membership as the Channel contract names it. */
export function membershipStatus(
  member: ChatMember,
): 'administrator' | 'member' | 'left' {
  switch (member.status) {
    case 'creator':
    case 'administrator':
      return 'administrator';
    case 'member':
      return 'member';
    case 'restricted':
      return member.is_member ? 'member' : 'left';
    default:
      return 'left';
  }
}
