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
  /**
   * Unique per integration; the Channel's external key. A chat's primary
   * Channel has the chat's own key, which chat migration relies on.
   */
  key: string;
  title: string | null;
  address: ChannelAddress;
  /**
   * The topic's ID within its chat; null for the chat's primary Channel,
   * such as a General topic, a group without topics, or a direct chat.
   */
  topicId: string | null;
}

/**
 * A command a message starts with, such as `/status` or `/model opus`, for
 * Pero rather than the Agent.
 */
export interface InboundCommand {
  /** Lowercased, without the `/` or the bot's name. */
  name: string;
  /** The rest of the message, trimmed; empty when there is none. */
  args: string;
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
  /**
   * The text, and the command it starts with, if any. A command Pero does
   * not know goes to the Agent as text.
   */
  content: { text: string; command?: InboundCommand };
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

/** Someone pressed a button of a message Pero sent. */
export interface InboundAction {
  integrationKind: IntegrationKind;
  updateId: string;
  chat: InboundChat;
  /** The Channel of the message the button belongs to. */
  channel: InboundChannel;
  /** The pressed button's `id`, as it was sent. */
  actionId: string;
  /** The message the button belongs to. */
  messageId: string;
  senderId: string;
  /** How to name the sender to the chat, such as `@ada`; null if unknown. */
  senderName: string | null;
}

/** What the person who pressed a button is shown; null shows nothing. */
export interface ActionResult {
  notice: string | null;
}

/** Where an adapter hands what it receives; set when it starts. */
export interface ChannelHandlers {
  onMessage(message: InboundMessage): Promise<void>;
  onEvent(event: ChannelEvent): Promise<void>;
  onAction(action: InboundAction): Promise<ActionResult>;
}

/** A button under a message; pressing it reaches `onAction` with its `id`. */
export interface OutboundButton {
  /** At most `MAX_BUTTON_ID_BYTES` bytes of UTF-8. */
  id: string;
  label: string;
}

/** The longest button ID every integration can carry (Telegram: 64). */
export const MAX_BUTTON_ID_BYTES = 64;

/** Buttons under a message, row by row. */
export type ButtonRows = readonly (readonly OutboundButton[])[];

export interface OutboundMessage {
  text: string;
  /** Shown under the message, row by row; none by default. */
  buttons?: ButtonRows;
}

/**
 * The integration's ID for a message it sent; the first part's ID when it
 * had to split the message into several.
 */
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
  /**
   * The key of the chat `address` belongs to, as `InboundChat.key` gives
   * it, so the allowlist can be checked before sending unprompted.
   */
  chatKey(address: ChannelAddress): string;
  /**
   * Replaces a sent message's text and buttons; a message without buttons
   * removes them. The text must fit in one message.
   */
  edit(
    address: ChannelAddress,
    messageId: string,
    message: OutboundMessage,
  ): Promise<void>;
}
