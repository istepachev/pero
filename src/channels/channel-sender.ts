import { Injectable, Logger } from '@nestjs/common';
import {
  type Author,
  MessageHistory,
} from '../history/message-history.service.js';
import type { Channel } from '../persistence/entities/channel.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import { SpeechService } from '../speech/speech.service.js';
import { answerParts } from '../speech/voice-reply.js';
import type {
  ChannelAdapter,
  ChannelAddress,
  OutboundMessage,
  OutboundVoice,
  SentMessage,
} from './channel-adapter.js';

/** What sending an answer did. */
export interface SentAnswer {
  /** The first message sent. */
  sent: SentMessage;
  /** The answer as the Channel's history keeps it. */
  text: string;
}

/** Starts a voice message's words in the history. */
export const VOICE_LINE = '[Voice message]';

/** The connected adapters, one per integration, and sending through them. */
@Injectable()
export class ChannelSender {
  private readonly logger = new Logger('Channels');
  private readonly adapters = new Map<IntegrationKind, ChannelAdapter>();

  constructor(
    private readonly history: MessageHistory,
    private readonly speech: SpeechService,
  ) {}

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

  /** Sends `voice` through `kind` as a voice message. */
  async sendVoice(
    kind: IntegrationKind,
    address: ChannelAddress,
    voice: OutboundVoice,
  ): Promise<SentMessage> {
    return this.adapter(kind).sendVoice(address, voice);
  }

  /**
   * Sends an agent's `answer`, part by part in order: the text as
   * Markdown, shown as the integration's formatting, and each `<voice>`
   * block recorded and sent as a voice message. A block that can't be
   * recorded goes out as text, saying why. An answer without blocks is
   * sent as one text. Throws when a send fails; the parts before
   * it are out by then.
   */
  async sendAnswer(
    kind: IntegrationKind,
    address: ChannelAddress,
    answer: string,
  ): Promise<SentAnswer> {
    const parts = answerParts(answer);
    if (!parts.some((part) => part.kind === 'voice')) {
      return {
        sent: await this.send(kind, address, { text: answer, markdown: true }),
        text: answer,
      };
    }
    let first: SentMessage | null = null;
    const kept: string[] = [];
    for (const part of parts) {
      let sent: SentMessage;
      if (part.kind === 'text') {
        sent = await this.send(kind, address, {
          text: part.text,
          markdown: true,
        });
        kept.push(part.text);
      } else {
        let voice: OutboundVoice | null = null;
        let problem = '';
        try {
          voice = await this.speech.speak(part.text);
        } catch (error) {
          problem = describe(error).replace(/\.$/, '');
          this.logger.warn(`Failed to record a voice message: ${problem}`);
        }
        if (voice === null) {
          const text =
            `${part.text}\n\n` +
            `(Pero couldn't send this as a voice message: ${problem}.)`;
          sent = await this.send(kind, address, { text });
          kept.push(text);
        } else {
          sent = await this.sendVoice(kind, address, voice);
          kept.push(`${VOICE_LINE}\n${part.text}`);
        }
      }
      first ??= sent;
    }
    return { sent: first!, text: kept.join('\n\n') };
  }

  /**
   * Sends an agent's `answer` to `channel` as `sendAnswer` does, then
   * records it in the Channel's history, its voice messages as their
   * words. A failed record is only logged.
   */
  async postAnswer(
    channel: Pick<Channel, 'id' | 'integrationKind' | 'address'>,
    answer: string,
    author: Author,
  ): Promise<SentMessage> {
    const { sent, text } = await this.sendAnswer(
      channel.integrationKind,
      channel.address,
      answer,
    );
    await this.record(channel, sent, text, author);
    return sent;
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
   * Marks received message `messageId` in `channel` as being answered, or
   * clears the mark. Best-effort: a failure is only logged.
   */
  async showWorking(
    channel: Pick<Channel, 'id' | 'integrationKind' | 'address'>,
    messageId: string,
    working: boolean,
  ): Promise<void> {
    try {
      await this.adapter(channel.integrationKind).showWorking(
        channel.address,
        messageId,
        working,
      );
    } catch (error) {
      this.logger.debug(
        `Failed to ${working ? 'mark' : 'unmark'} message ${messageId} ` +
          `in Channel ${channel.id}: ${describe(error)}`,
      );
    }
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
    await this.record(channel, sent, text, author);
    return sent;
  }

  private async record(
    channel: Pick<Channel, 'id'>,
    sent: SentMessage,
    text: string,
    author: Author,
  ): Promise<void> {
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
          describe(error),
      );
    }
  }

  private adapter(kind: IntegrationKind): ChannelAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No ${kind} adapter is connected`);
    return adapter;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
