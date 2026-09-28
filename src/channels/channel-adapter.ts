import type { ChatKind, IntegrationKind } from '../persistence/entities/sql.js';

/*
 * The contract between the Channel router and a communication integration.
 * An adapter turns its service's updates into these shapes and sends
 * replies to its own addresses; the rest of Pero never sees a provider
 * object. Keys and addresses are opaque outside the adapter that made them.
 */

/** An integration's structured address; stored as a Channel's address JSON. */
export type ChannelAddress = Readonly<Record<string, unknown>>;

/** The chat an update came from; allowlisting works per chat. */
export interface InboundChat {
  /** The chat's ID as a string, such as a Telegram chat ID. */
  key: string;
  kind: ChatKind;
  title: string | null;
  /** Where to reach the chat as a whole: no topic or thread. */
  address: ChannelAddress;
}

/** The conversation endpoint within a chat, such as one Telegram topic. */
export interface InboundChannel {
  /** Unique per integration; the Channel's external key. */
  key: string;
  title: string | null;
  address: ChannelAddress;
}

/** A message normalized by its adapter. */
export interface InboundMessage {
  integrationKind: IntegrationKind;
  /** The integration's update ID, which deduplicates redelivery. */
  updateId: string;
  chat: InboundChat;
  channel: InboundChannel;
  messageId: string;
  senderId: string;
  content: { text: string };
}

interface ChannelEventBase {
  integrationKind: IntegrationKind;
  updateId: string;
  chat: InboundChat;
}

/** Something that changed a chat or Channel rather than a message to answer. */
export type ChannelEvent =
  | (ChannelEventBase & {
      type: 'topic-created' | 'topic-renamed';
      channel: InboundChannel;
    })
  | (ChannelEventBase & {
      /** The chat now lives under a new ID, as when a group gains topics. */
      type: 'chat-migrated';
      newChatKey: string;
      newAddress: ChannelAddress;
    })
  | (ChannelEventBase & {
      /** The bot's own membership in the chat changed. */
      type: 'membership-changed';
      status: 'administrator' | 'member' | 'left';
    });

/** Where an adapter hands what it receives; set when it starts. */
export interface ChannelHandlers {
  onMessage(message: InboundMessage): Promise<void>;
  onEvent(event: ChannelEvent): Promise<void>;
}

export interface OutboundMessage {
  text: string;
}

/** The integration's ID for a message it sent. */
export interface SentMessage {
  messageId: string;
}

/** One communication integration, such as Telegram. */
export interface ChannelAdapter {
  readonly kind: IntegrationKind;
  /** Begins intake; updates go to `handlers` from then on. */
  start(handlers: ChannelHandlers): Promise<void>;
  /** Ends intake. Sending may still work until the process exits. */
  stop(): Promise<void>;
  send(address: ChannelAddress, message: OutboundMessage): Promise<SentMessage>;
}
