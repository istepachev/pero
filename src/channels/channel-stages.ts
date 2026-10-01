import {
  type AgentDefinition,
  type Definitions,
  type Route,
  routeQuery,
  type Unanswered,
} from '../definitions/definitions.js';
import type { Channel } from '../persistence/entities/channel.entity.js';
import type { ChannelEvent, InboundMessage } from './channel-adapter.js';

/*
 * The stages after the router. Each is an abstract class so it can serve as
 * its own injection token; onboarding and the Agent manager provide the real
 * ones.
 */

/** A known Channel with the enabled Agent that answers there now. */
export type RoutedChannel = Channel & { agent: AgentDefinition };

/** Who answers in `channel` now. */
export function routeOf(
  channel: Pick<Channel, 'id' | 'externalKey' | 'title'>,
  definitions: Definitions,
): Promise<Route> {
  return definitions.route(routeQuery(channel));
}

/**
 * What Pero replies, once, in a Channel no one answers in: why, and what
 * to edit.
 */
export function unansweredText(reason: Unanswered): string {
  switch (reason.kind) {
    case 'disabled':
      return (
        `Agent ${reason.agent} is disabled, so no one answers here. ` +
        `To turn it back on, set enabled: true in ${reason.file}.`
      );
    case 'conflict':
      return (
        `No one answers in this topic: ${together(reason.files)} claim ` +
        `"${reason.title}" in their topics. Keep it in only one of them.`
      );
    case 'unloaded':
      return (
        `No one answers in this topic yet: ${together(reason.files)} ` +
        `${reason.files.length === 1 ? 'claims' : 'claim'} "${reason.title}" ` +
        `but ${reason.files.length === 1 ? 'has' : 'have'} errors, so ` +
        `${reason.files.length === 1 ? "it hasn't" : "they haven't"} loaded. ` +
        `Run pero check on the Pero host to see them.`
      );
    case 'unclaimed':
      return (
        `No Agent answers in this topic: none lists "${reason.title}" in its ` +
        `topics. Add it to an Agent note's topics, or create ${reason.note} ` +
        `with topics: [${reason.title}].`
      );
    case 'untitled':
      return (
        `Pero doesn't know this topic's title yet, so no Agent can claim it. ` +
        `Rename the topic, or send a message that isn't a reply, and Pero ` +
        `will pick up its title.`
      );
    case 'no-main-agent':
      return (
        `No one answers here: no note defines the main Agent, ` +
        `${reason.agent}. Add ${reason.note}.`
      );
  }
}

/** Why no one answers in a Channel, for the log and `pero channels`. */
export function unansweredSummary(reason: Unanswered): string {
  switch (reason.kind) {
    case 'disabled':
      return `Agent ${reason.agent} is disabled`;
    case 'conflict':
      return `"${reason.title}" is claimed by ${together(reason.files)}`;
    case 'unloaded':
      return `"${reason.title}" is claimed only by ${together(reason.files)}, which ${reason.files.length === 1 ? 'has' : 'have'} errors`;
    case 'unclaimed':
      return `no Agent claims "${reason.title}"`;
    case 'untitled':
      return "the topic's title isn't known yet";
    case 'no-main-agent':
      return `no note defines the main Agent, ${reason.agent}; add ${reason.note}`;
  }
}

/** `files` in a sentence: `a`, `a and b`, or `a, b, and c`. */
function together(files: readonly string[]): string {
  if (files.length <= 2) return files.join(' and ');
  return `${files.slice(0, -1).join(', ')}, and ${files.at(-1)}`;
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
  abstract onUnknownChannel(message: InboundMessage): Promise<Channel | null>;

  /**
   * Who answers in `channel` now. In a workspace, Pero first writes the
   * note that answers there when it should: a new topic's Agent, or the
   * main Agent's.
   */
  abstract answer(channel: Channel): Promise<Route>;

  /** Any event from an allowed chat. */
  abstract onEvent(event: ChannelEvent): Promise<void>;
}
