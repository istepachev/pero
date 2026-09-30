import type { DefinitionIds } from '../definitions/definition-ids.js';
import {
  type AgentDefinition,
  type Definitions,
  requireAgent,
} from '../definitions/definitions.js';
import type { Channel } from '../persistence/entities/channel.entity.js';
import type { ChannelEvent, InboundMessage } from './channel-adapter.js';

/*
 * The stages after the router. Each is an abstract class so it can serve as
 * its own injection token; onboarding and the Agent manager provide the real
 * ones.
 */

/** A known, enabled Channel with its assigned Agent. */
export type RoutedChannel = Omit<Channel, 'agent'> & { agent: AgentDefinition };

/** `channel`, given the Agent assigned to it. */
export async function routedChannel(
  channel: Channel,
  definitions: Definitions,
  ids: DefinitionIds,
): Promise<RoutedChannel> {
  const name = await ids.agentName(channel.agentId);
  return Object.assign(channel, {
    agent: await requireAgent(definitions, name),
  });
}

/** Runs a turn of a known Channel's Agent. */
export abstract class ChannelTurns {
  /**
   * Accepts `message`, recorded in the Channel's history as `messageId`, as
   * the Channel's next turn. Resolves once the turn is accepted, not when
   * it finishes, so intake never waits on an Agent.
   */
  abstract handle(
    channel: RoutedChannel,
    message: InboundMessage,
    messageId: number,
  ): Promise<void>;

  /**
   * Lets accepted turns finish, or ends them, and sends their replies.
   * Intake has stopped by then.
   */
  abstract drain(): Promise<void>;
}

/** Creates Channels and follows chat changes in allowed chats. */
export abstract class ChannelOnboarding {
  /**
   * A message in an allowed chat for a Channel key Pero does not know.
   * Resolves to the Channel it now has, which the message goes on to, or
   * null when none could be set up yet.
   */
  abstract onUnknownChannel(
    message: InboundMessage,
  ): Promise<RoutedChannel | null>;

  /** Any event from an allowed chat. */
  abstract onEvent(event: ChannelEvent): Promise<void>;
}
