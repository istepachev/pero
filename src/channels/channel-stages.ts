import type { Channel } from '../persistence/entities/channel.entity.js';
import type { ChannelNote } from '../system-files/snapshot.js';
import {
  type Definitions,
  type Route,
  routeQuery,
  type Unanswered,
} from '../system/definitions.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import type {
  ChannelEvent,
  InboundChat,
  InboundMessage,
} from './channel-adapter.js';

/*
 * The stages after the router. Each is an abstract class so it can serve as
 * its own injection token; onboarding and the Agent manager provide the real
 * ones.
 */

/** A known Channel with the enabled note Pero answers there with now. */
export type RoutedChannel = Channel & { note: ChannelNote };

/** How Pero answers in `channel` now. */
export function routeOf(
  channel: Pick<Channel, 'id' | 'integrationKind' | 'externalKey' | 'title'>,
  definitions: Definitions,
): Route {
  return definitions.route(routeQuery(channel));
}

/**
 * What Pero replies, once, in a Channel it doesn't answer in: why, and
 * what to edit.
 */
export function unansweredText(reason: Unanswered): string {
  switch (reason.kind) {
    case 'disabled':
      return (
        `Pero doesn't answer here: ${reason.file} sets enabled: false. ` +
        `To turn it back on, set enabled: true there.`
      );
    case 'unloaded':
      return (
        `Pero doesn't answer here yet: ${together(reason.files)} ` +
        `${reason.files.length === 1 ? 'is' : 'are'} this Channel's note ` +
        `but ${reason.files.length === 1 ? 'has' : 'have'} errors, so ` +
        `${reason.files.length === 1 ? "it hasn't" : "they haven't"} loaded. ` +
        `Run pero check on the Pero host to see them.`
      );
    case 'untitled':
      return (
        `Pero doesn't know this topic's title yet, so it can't give it a ` +
        `note. Rename the topic, or send a message that isn't a reply, and ` +
        `Pero will pick up its title.`
      );
  }
}

/** Why Pero doesn't answer in a Channel, for the log and `pero channels`. */
export function unansweredSummary(reason: Unanswered): string {
  switch (reason.kind) {
    case 'disabled':
      return `${reason.file} sets enabled: false`;
    case 'unloaded':
      return `its note ${together(reason.files)} ${reason.files.length === 1 ? 'has' : 'have'} errors`;
    case 'untitled':
      return "the topic's title isn't known yet";
  }
}

/** `files` in a sentence: `a`, `a and b`, or `a, b, and c`. */
function together(files: readonly string[]): string {
  if (files.length <= 2) return files.join(' and ');
  return `${files.slice(0, -1).join(', ')}, and ${files.at(-1)}`;
}

/** Runs a turn in a known Channel. */
export abstract class ChannelTurns {
  /**
   * Accepts `message`, recorded in the Channel's history as `messageId`, as
   * the Channel's next turn, with the images it came with saved at `images`
   * and named in its text. Resolves once the turn is accepted, not when it
   * finishes, so intake never waits on a turn.
   */
  abstract handle(
    channel: RoutedChannel,
    message: InboundMessage,
    messageId: number,
    images: readonly string[],
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
   * How Pero answers in `channel` now. In a workspace, Pero first writes
   * or binds the note `channel` uses when it has none.
   */
  abstract answer(channel: Channel): Promise<Route>;

  /** Any event from an allowed chat. */
  abstract onEvent(event: ChannelEvent): Promise<void>;

  /**
   * `chat` was just allowed: records its primary Channel and, when Pero
   * answers there, welcomes it with the first steps, before anyone writes.
   * A chat whose primary Channel is known already gets nothing.
   */
  abstract onChatAllowed(
    kind: IntegrationKind,
    chat: InboundChat,
  ): Promise<void>;
}
