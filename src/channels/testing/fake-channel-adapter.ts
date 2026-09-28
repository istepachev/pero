import type { IntegrationKind } from '../../persistence/entities/sql.js';
import type {
  ActionResult,
  ChannelAdapter,
  ChannelAddress,
  ChannelEvent,
  ChannelHandlers,
  InboundChannel,
  InboundChat,
  InboundMessage,
  InboundAction,
  OutboundMessage,
  SentMessage,
} from '../channel-adapter.js';

/** A message the fake adapter was asked to send. */
export interface SentRecord {
  address: ChannelAddress;
  message: OutboundMessage;
}

/** An edit the fake adapter was asked to make. */
export interface EditRecord {
  address: ChannelAddress;
  messageId: string;
  message: OutboundMessage;
}

/**
 * An in-memory Channel adapter for tests. `deliver`, `emit`, and `press`
 * play an update into the router and wait until it has been routed; `sent`
 * and `edited` record everything sent back. The message `sent[i]` has the
 * ID `String(i + 1)`.
 */
export class FakeChannelAdapter implements ChannelAdapter {
  readonly sent: SentRecord[] = [];
  readonly edited: EditRecord[] = [];
  running = false;
  /** Makes the next sends fail, as an unreachable service would. */
  failSends = false;
  private handlers: ChannelHandlers | null = null;
  private nextMessageId = 1;

  constructor(readonly kind: IntegrationKind = 'telegram') {}

  start(handlers: ChannelHandlers): Promise<void> {
    this.handlers = handlers;
    this.running = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    return Promise.resolve();
  }

  send(
    address: ChannelAddress,
    message: OutboundMessage,
  ): Promise<SentMessage> {
    if (this.failSends) return Promise.reject(new Error('Service unreachable'));
    this.sent.push({ address, message });
    return Promise.resolve({ messageId: String(this.nextMessageId++) });
  }

  edit(
    address: ChannelAddress,
    messageId: string,
    message: OutboundMessage,
  ): Promise<void> {
    if (this.failSends) return Promise.reject(new Error('Service unreachable'));
    this.edited.push({ address, messageId, message });
    return Promise.resolve();
  }

  deliver(message: InboundMessage): Promise<void> {
    return this.started().onMessage(message);
  }

  emit(event: ChannelEvent): Promise<void> {
    return this.started().onEvent(event);
  }

  /**
   * Presses the button labelled `label` under `record`, one of `sent`, as
   * someone in `chat` (in topic `topic` when given).
   */
  press(
    record: SentRecord,
    label: string,
    chat: InboundChat,
    options: { topic?: string; senderName?: string | null } = {},
  ): Promise<ActionResult> {
    const button = record.message.buttons?.find((b) => b.label === label);
    if (!button) throw new Error(`No button labelled ${label}`);
    return this.started().onAction(
      buttonPress(chat, {
        ...options,
        actionId: button.id,
        messageId: String(this.sent.indexOf(record) + 1),
      }),
    );
  }

  private started(): ChannelHandlers {
    if (!this.handlers || !this.running) {
      throw new Error('The fake adapter is not started');
    }
    return this.handlers;
  }
}

let nextUpdateId = 1;
let nextMessageId = 1;

/** A group chat, addressed the way the Telegram adapter will address it. */
export function groupChat(
  key: string,
  title: string | null = null,
): InboundChat {
  return { key, kind: 'group', title, address: { chatId: key } };
}

/** A direct chat with the bot; its key is the user's ID. */
export function privateChat(key: string): InboundChat {
  return { key, kind: 'private', title: null, address: { chatId: key } };
}

/**
 * Topic `topic` of `chat`, titled `title` (by default `Topic <topic>`), or
 * the chat's primary Channel when `topic` is undefined.
 */
export function inboundChannel(
  chat: InboundChat,
  topic?: string,
  title: string | null = `Topic ${topic}`,
): InboundChannel {
  return topic === undefined
    ? { key: chat.key, title: chat.title, address: chat.address, topicId: null }
    : {
        key: `${chat.key}:${topic}`,
        title,
        address: { ...chat.address, messageThreadId: topic },
        topicId: topic,
      };
}

/**
 * A text message in `chat`, in topic `topic` when given, otherwise in the
 * chat's primary Channel. Each gets a fresh update ID unless one is given.
 * A null `title` stands for a topic message without its topic's creation.
 */
export function inboundMessage(
  chat: InboundChat,
  options: {
    topic?: string;
    title?: string | null;
    text?: string;
    updateId?: string;
  } = {},
): InboundMessage {
  return {
    integrationKind: 'telegram',
    updateId: options.updateId ?? String(nextUpdateId++),
    chat,
    channel: inboundChannel(chat, options.topic, options.title),
    messageId: String(nextMessageId++),
    senderId: '42',
    content: { text: options.text ?? 'Hello' },
  };
}

/** A press of button `actionId` under message `messageId` in `chat`. */
export function buttonPress(
  chat: InboundChat,
  options: {
    actionId: string;
    messageId: string;
    topic?: string;
    senderName?: string | null;
  },
): InboundAction {
  return {
    integrationKind: 'telegram',
    updateId: String(nextUpdateId++),
    chat,
    channel: inboundChannel(chat, options.topic),
    actionId: options.actionId,
    messageId: options.messageId,
    senderId: '42',
    senderName: options.senderName === undefined ? '@ada' : options.senderName,
  };
}

/** The bot's membership in `chat` changing to `status`. */
export function membershipChanged(
  chat: InboundChat,
  status: 'administrator' | 'member' | 'left',
): ChannelEvent {
  return {
    type: 'membership-changed',
    integrationKind: 'telegram',
    updateId: String(nextUpdateId++),
    chat,
    status,
  };
}

/** Topic `topic` created in `chat`, titled `title`. */
export function topicCreated(
  chat: InboundChat,
  topic: string,
  options: { title?: string | null; updateId?: string } = {},
): ChannelEvent {
  return {
    type: 'topic-created',
    integrationKind: 'telegram',
    updateId: options.updateId ?? String(nextUpdateId++),
    chat,
    channel: inboundChannel(chat, topic, options.title),
  };
}

/** Topic `topic` in `chat` renamed to `title`. */
export function topicRenamed(
  chat: InboundChat,
  topic: string,
  title: string,
): ChannelEvent {
  return {
    type: 'topic-renamed',
    integrationKind: 'telegram',
    updateId: String(nextUpdateId++),
    chat,
    channel: inboundChannel(chat, topic, title),
  };
}

/** `chat` moved to the new ID `newKey`, as when a group gains topics. */
export function chatMigrated(chat: InboundChat, newKey: string): ChannelEvent {
  return {
    type: 'chat-migrated',
    integrationKind: 'telegram',
    updateId: String(nextUpdateId++),
    chat,
    newChatKey: newKey,
    newAddress: { chatId: newKey },
  };
}
