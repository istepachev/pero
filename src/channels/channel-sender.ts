import { Injectable, Logger } from '@nestjs/common';
import {
  type Author,
  MessageHistory,
} from '../history/message-history.service.js';
import type { Channel } from '../persistence/entities/channel.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import type {
  ChannelAdapter,
  ChannelAddress,
  OutboundMessage,
  SentMessage,
} from './channel-adapter.js';

/** The connected adapters, one per integration, and sending through them. */
@Injectable()
export class ChannelSender {
  private readonly logger = new Logger('Channels');
  private readonly adapters = new Map<IntegrationKind, ChannelAdapter>();

  constructor(private readonly history: MessageHistory) {}

  add(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`A ${adapter.kind} adapter is already connected`);
    }
    this.adapters.set(adapter.kind, adapter);
  }

  all(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  async send(
    kind: IntegrationKind,
    address: ChannelAddress,
    message: OutboundMessage,
  ): Promise<SentMessage> {
    return this.adapter(kind).send(address, message);
  }

  /** The key of the chat `address` belongs to; see `ChannelAdapter`. */
  chatKey(kind: IntegrationKind, address: ChannelAddress): string {
    return this.adapter(kind).chatKey(address);
  }

  /** The contents of a file a message from `kind` came with. */
  download(kind: IntegrationKind, ref: string): Promise<Uint8Array> {
    return this.adapter(kind).download(ref);
  }

  /** Replaces the text and buttons of a message sent through `kind`. */
  async edit(
    kind: IntegrationKind,
    address: ChannelAddress,
    messageId: string,
    message: OutboundMessage,
  ): Promise<void> {
    return this.adapter(kind).edit(address, messageId, message);
  }

  /**
   * Sends `text` to `channel`, then records it in the Channel's history. A
   * failed send throws and records nothing; a failed record is only logged,
   * since the message is out by then.
   */
  async post(
    channel: Pick<Channel, 'id' | 'integrationKind' | 'address'>,
    text: string,
    author: Author,
  ): Promise<SentMessage> {
    const sent = await this.send(channel.integrationKind, channel.address, {
      text,
    });
    try {
      await this.history.recordOutbound({
        channelId: channel.id,
        externalMessageId: sent.messageId,
        text,
        author,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record a message sent in Channel ${channel.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return sent;
  }

  private adapter(kind: IntegrationKind): ChannelAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No ${kind} adapter is connected`);
    return adapter;
  }
}
