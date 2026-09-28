import type { IntegrationKind } from '../../persistence/entities/sql.js';
import type {
  ChannelAdapter,
  ChannelAddress,
  ChannelEvent,
  ChannelHandlers,
  InboundChat,
  InboundMessage,
  OutboundMessage,
  SentMessage,
} from '../channel-adapter.js';

/** A message the fake adapter was asked to send. */
export interface SentRecord {
  address: ChannelAddress;
  message: OutboundMessage;
}

/**
 * An in-memory Channel adapter for tests. `deliver` and `emit` play an
 * update into the router and wait until it has been routed; `sent` records
 * everything sent back.
 */
export class FakeChannelAdapter implements ChannelAdapter {
  readonly sent: SentRecord[] = [];
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

  deliver(message: InboundMessage): Promise<void> {
    return this.started().onMessage(message);
  }

  emit(event: ChannelEvent): Promise<void> {
    return this.started().onEvent(event);
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
 * A text message in `chat`, in topic `topic` when given, otherwise in the
 * chat's primary Channel. Each gets a fresh update ID unless one is given.
 */
export function inboundMessage(
  chat: InboundChat,
  options: { topic?: string; text?: string; updateId?: string } = {},
): InboundMessage {
  const { topic } = options;
  return {
    integrationKind: 'telegram',
    updateId: options.updateId ?? String(nextUpdateId++),
    chat,
    channel:
      topic === undefined
        ? { key: chat.key, title: chat.title, address: chat.address }
        : {
            key: `${chat.key}:${topic}`,
            title: `Topic ${topic}`,
            address: { ...chat.address, messageThreadId: topic },
          },
    messageId: String(nextMessageId++),
    senderId: '42',
    content: { text: options.text ?? 'Hello' },
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

/** Topic `topic` created in `chat`. */
export function topicCreated(
  chat: InboundChat,
  topic: string,
  updateId = String(nextUpdateId++),
): ChannelEvent {
  return {
    type: 'topic-created',
    integrationKind: 'telegram',
    updateId,
    chat,
    channel: {
      key: `${chat.key}:${topic}`,
      title: `Topic ${topic}`,
      address: { ...chat.address, messageThreadId: topic },
    },
  };
}
