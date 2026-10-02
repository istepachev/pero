import { Injectable, Logger } from '@nestjs/common';
import type { Channel } from '../persistence/entities/channel.entity.js';
import type { Unanswered } from '../system/definitions.js';
import { ChannelSender } from './channel-sender.js';
import { unansweredSummary, unansweredText } from './channel-stages.js';

/**
 * Tells a Channel no one answers in why, once: again only when the reason
 * changes, or after an Agent answered there in between. The reply stays
 * out of the Channel's history, and the message isn't kept for later.
 * Kept in memory, so a restart may repeat a reply once.
 */
@Injectable()
export class UnansweredReplies {
  private readonly logger = new Logger('Channels');
  /** The reason each Channel was last told, by Channel ID. */
  private readonly told = new Map<number, string>();

  constructor(private readonly sender: ChannelSender) {}

  /** An Agent answers in Channel `id` again. */
  answered(id: number): void {
    this.told.delete(id);
  }

  /** Says why no one answers in `channel`, unless it was told already. */
  async explain(
    channel: Pick<Channel, 'id' | 'integrationKind' | 'address'>,
    reason: Unanswered,
  ): Promise<void> {
    const key = JSON.stringify(reason);
    if (this.told.get(channel.id) === key) {
      this.logger.debug(
        `Ignored a message in Channel ${channel.id}: ${unansweredSummary(reason)}`,
      );
      return;
    }
    this.told.set(channel.id, key);
    this.logger.warn(
      `No one answers in ${channel.integrationKind} Channel ${channel.id}: ` +
        unansweredSummary(reason),
    );
    try {
      await this.sender.send(channel.integrationKind, channel.address, {
        text: unansweredText(reason),
      });
    } catch (error) {
      this.logger.warn(
        `Failed to post in Channel ${channel.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
