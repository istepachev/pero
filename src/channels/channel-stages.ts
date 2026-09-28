import { Injectable, Logger } from '@nestjs/common';
import type { Agent } from '../persistence/entities/agent.entity.js';
import type { Channel } from '../persistence/entities/channel.entity.js';
import type { ChannelEvent, InboundMessage } from './channel-adapter.js';

/*
 * The stages after the router. Each is an abstract class so it can serve as
 * its own injection token; onboarding and the Agent manager provide the real
 * ones.
 */

/** A known, enabled Channel with its assigned Agent. */
export type RoutedChannel = Channel & { agent: Agent };

/** Runs a turn of a known Channel's Agent. */
export abstract class ChannelTurns {
  /**
   * Accepts `message` as the Channel's next turn. Resolves once the turn is
   * accepted, not when it finishes, so intake never waits on an Agent.
   */
  abstract handle(
    channel: RoutedChannel,
    message: InboundMessage,
  ): Promise<void>;
}

/** Creates Channels and follows chat changes in allowed chats. */
export abstract class ChannelOnboarding {
  /** A message in an allowed chat for a Channel key Pero does not know. */
  abstract onUnknownChannel(message: InboundMessage): Promise<void>;

  /** Any event from an allowed chat. */
  abstract onEvent(event: ChannelEvent): Promise<void>;
}

/** Stands in until the Agent manager can run turns. */
@Injectable()
export class UnwiredChannelTurns extends ChannelTurns {
  private readonly logger = new Logger('Channels');

  handle(channel: RoutedChannel): Promise<void> {
    this.logger.warn(
      `Agents cannot answer yet; dropped a message for Channel ${channel.id}`,
    );
    return Promise.resolve();
  }
}

/** Stands in until Channel onboarding exists. */
@Injectable()
export class UnwiredChannelOnboarding extends ChannelOnboarding {
  private readonly logger = new Logger('Channels');

  onUnknownChannel(message: InboundMessage): Promise<void> {
    this.logger.warn(
      `Onboarding is not available yet; dropped a message for new ` +
        `${message.integrationKind} Channel ${message.channel.key}`,
    );
    return Promise.resolve();
  }

  onEvent(event: ChannelEvent): Promise<void> {
    this.logger.warn(
      `Onboarding is not available yet; ignored ${event.type} in ` +
        `${event.integrationKind} chat ${event.chat.key}`,
    );
    return Promise.resolve();
  }
}
