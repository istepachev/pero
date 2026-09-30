import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AgentsService, MAIN_AGENT_NAME } from '../agents/agents.service.js';
import { InvalidInputError } from '../common/errors.js';
import {
  type AgentDefinition,
  Definitions,
  type Route,
  routeQuery,
  type Unanswered,
} from '../definitions/definitions.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { LegacyChannelAgent } from '../persistence/entities/legacy-channel-agent.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import { inTransaction } from '../persistence/transaction.js';
import { topicClaim } from '../settings-files/snapshot.js';
import { AgentNotes } from '../settings-notes/agent-notes.service.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { AgentNamer } from './agent-namer.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type {
  ChannelEvent,
  InboundChannel,
  InboundMessage,
} from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import {
  ChannelOnboarding,
  routeOf,
  unansweredSummary,
} from './channel-stages.js';

export { MAIN_AGENT_NAME };

/** Posted in a new Channel: who answers there and how to change it. */
export function welcomeText(
  agent: Pick<AgentDefinition, 'name' | 'provider' | 'providerOptions'>,
  folder: string,
  where: 'topic' | 'chat',
): string {
  const { model } = agent.providerOptions;
  return (
    `This ${where} talks to Agent ${agent.name}: ${agent.provider}, ` +
    `${model === null ? 'default model' : `model ${model}`}, ` +
    `working in ${folder}. ` +
    `To see where to change it, run on the Pero host: pero agents show ${agent.name}`
  );
}

/** Posted instead of a welcome when no Agent can be created yet. */
export function setupHint(reason: string): string {
  return (
    `Pero can't set up an Agent here yet. ${reason}. ` +
    `Agents work in a workspace's data folder: run on the Pero host ` +
    `pero migrate <workspace>, then start Pero there`
  );
}

/**
 * Records each new Channel in an allowed chat, and welcomes it when an
 * Agent answers there. In a workspace, notes choose that Agent on every
 * message, and Pero writes the note that answers a topic no Agent claims
 * (with `new-topics: create-agent`) and the main Agent's when a primary
 * Channel finds none; a renamed topic's title follows in the note that
 * claims it. A legacy data directory still assigns an Agent: a topic gets
 * a new one named after it, and a chat's primary Channel the main Agent.
 */
@Injectable()
export class ChannelOnboardingService extends ChannelOnboarding {
  private readonly logger = new Logger('Channels');
  /**
   * Note writes and topic renames, one at a time, so a topic's first
   * message and its topic-created event write one note between them.
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** The Channels welcomed while Pero runs, by ID, so none is twice. */
  private readonly welcomed = new Set<number>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly agents: AgentsService,
    private readonly namer: AgentNamer,
    private readonly sender: ChannelSender,
    private readonly allowedChats: AllowedChatsService,
    private readonly definitions: Definitions,
    private readonly notes: SettingsNotes,
    private readonly agentNotes: AgentNotes,
  ) {
    super();
  }

  answer(channel: Channel): Promise<Route> {
    return this.settle(channel, false);
  }

  onUnknownChannel(message: InboundMessage): Promise<Channel | null> {
    return this.onboard(message.integrationKind, message.channel);
  }

  async onEvent(event: ChannelEvent): Promise<void> {
    switch (event.type) {
      case 'topic-created':
        await this.onboard(event.integrationKind, event.channel);
        return;
      case 'topic-renamed':
        await this.rename(event.integrationKind, event.channel);
        return;
      case 'chat-migrated':
        await this.migrate(event);
        return;
      default:
        // The adapter follows the bot's membership itself.
        this.logger.debug(
          `Onboarding ignored ${event.type} in ${event.integrationKind} ` +
            `chat ${event.chat.key}`,
        );
    }
  }

  /**
   * The Channel for `inbound`, creating it when new, in a legacy data
   * directory with its Agent in the same transaction, and welcoming it when
   * an Agent answers there. Null, after a hint in the Channel, when a
   * legacy Agent cannot be created yet; the next attempt tries again.
   */
  private async onboard(
    kind: IntegrationKind,
    inbound: InboundChannel,
  ): Promise<Channel | null> {
    const legacy = !this.notes.inWorkspace();
    // Named before the transaction: a namer may be slow, and the
    // transaction queue must not wait on it.
    const name =
      legacy && inbound.topicId !== null
        ? await this.namer.suggest(inbound)
        : null;

    let result: { channel: Channel; created: boolean };
    try {
      result = await inTransaction(this.dataSource, async (manager) => {
        const existing = await findChannel(manager, kind, inbound.key);
        if (existing !== null) return { channel: existing, created: false };

        const channels = manager.getRepository(Channel);
        const channel = await channels.save(
          channels.create({
            integrationKind: kind,
            externalKey: inbound.key,
            address: { ...inbound.address },
            title: inbound.title,
          }),
        );
        if (legacy) {
          const agent =
            name === null
              ? await this.agents.mainAgentWithin(manager)
              : await this.agents.createForTopicWithin(manager, {
                  base: name,
                  title: inbound.title,
                });
          await manager
            .getRepository(LegacyChannelAgent)
            .insert({ channelId: channel.id, agentName: agent.name });
        }
        return {
          channel: (await findChannel(manager, kind, inbound.key))!,
          created: true,
        };
      });
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
      this.logger.warn(
        `Could not onboard ${kind} Channel ${inbound.key}: ${error.message}`,
      );
      // No Channel yet, so the hint has no history to join.
      await this.notify(kind, inbound.key, () =>
        this.sender.send(kind, inbound.address, {
          text: setupHint(error.message),
        }),
      );
      return null;
    }

    const { channel, created } = result;
    if (!created) return channel;
    if (legacy) this.agents.committed();
    this.logger.log(`Onboarded ${kind} Channel ${inbound.key}`);
    await this.settle(channel, true);
    return channel;
  }

  /**
   * Who answers in `channel` now, writing the note that answers it when
   * Pero should, and welcoming it when it is new or Pero wrote that note.
   */
  private async settle(channel: Channel, created: boolean): Promise<Route> {
    let route = await routeOf(channel, this.definitions);
    let wrote = false;
    if (route.kind === 'unanswered' && this.writesFor(channel, route.reason)) {
      ({ route, wrote } = await this.serially(() => this.writeFor(channel)));
    }
    if (route.kind === 'agent' && (created || wrote)) {
      await this.welcome(channel, route.agent);
    }
    return route;
  }

  /**
   * Whether Pero writes a note where no one answers for `reason`: a topic
   * no Agent claims, which `unclaimed` means only with `new-topics:
   * create-agent`, or a primary Channel without the main Agent's note.
   */
  private writesFor(channel: Channel, reason: Unanswered): boolean {
    if (!this.notes.inWorkspace()) return false;
    return (
      reason.kind === 'unclaimed' ||
      (reason.kind === 'no-main-agent' && routeQuery(channel).primary)
    );
  }

  /**
   * Writes the note that answers in `channel`, unless one appeared while
   * this waited its turn; runs in the queue. Where writing fails, the
   * Channel stays unanswered and is told why as before.
   */
  private async writeFor(
    channel: Channel,
  ): Promise<{ route: Route; wrote: boolean }> {
    const route = await routeOf(channel, this.definitions);
    if (route.kind !== 'unanswered' || !this.writesFor(channel, route.reason)) {
      return { route, wrote: false };
    }
    const { reason } = route;
    let file: string | null;
    try {
      file =
        reason.kind === 'unclaimed'
          ? await this.agentNotes.createForTopic(
              reason.title,
              topicIdOf(channel),
            )
          : reason.kind === 'no-main-agent'
            ? await this.agentNotes.createMain(reason.agent)
            : null;
    } catch (error) {
      this.logger.warn(
        `Could not write a note for ${channel.integrationKind} Channel ` +
          `${channel.externalKey}: ${describe(error)}`,
      );
      return { route, wrote: false };
    }
    if (file === null) return { route, wrote: false };
    const after = await routeOf(channel, this.definitions);
    if (after.kind === 'unanswered') {
      this.logger.warn(
        `Wrote ${file}, but no one answers in ${channel.integrationKind} ` +
          `Channel ${channel.externalKey} yet: ${unansweredSummary(after.reason)}`,
      );
    } else {
      this.logger.log(
        `${channel.integrationKind} Channel ${channel.externalKey} is ` +
          `answered by Agent ${after.agent.name}, from the new ${file}`,
      );
    }
    return { route: after, wrote: true };
  }

  /** Posts the welcome in `channel`, once while Pero runs. */
  private async welcome(
    channel: Channel,
    agent: AgentDefinition,
  ): Promise<void> {
    if (this.welcomed.has(channel.id)) return;
    this.welcomed.add(channel.id);
    const text = welcomeText(
      agent,
      agent.workingDirectory,
      routeQuery(channel).primary ? 'chat' : 'topic',
    );
    await this.notify(channel.integrationKind, channel.externalKey, () =>
      this.sender.post(channel, text, { origin: 'pero' }),
    );
  }

  /** Runs `work` after the note writes and renames before it. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Retitles a renamed topic's Channel. In a workspace, the note claiming
   * its old title claims the new one instead, so the topic stays with its
   * Agent. In a legacy data directory, it retitles the topic's Agent too
   * while the Agent's title still mirrors the topic's; never the Agent's
   * name.
   */
  private async rename(
    kind: IntegrationKind,
    inbound: InboundChannel,
  ): Promise<void> {
    const legacy = !this.notes.inWorkspace();
    if (!legacy) {
      await this.serially(() => this.renameInNotes(kind, inbound));
      return;
    }
    const found = await inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, kind, inbound.key);
      if (channel === null) return false;
      if (legacy && inbound.topicId !== null) {
        const route = await manager
          .getRepository(LegacyChannelAgent)
          .findOneBy({ channelId: channel.id });
        if (route !== null) {
          await this.agents.retitleWithin(
            manager,
            route.agentName,
            channel.title,
            inbound.title,
          );
        }
      }
      await manager
        .getRepository(Channel)
        .update(channel.id, { title: inbound.title });
      return true;
    });
    if (found && legacy && inbound.topicId !== null) this.agents.committed();
    if (!found) {
      this.logger.debug(
        `Ignored the rename of unknown ${kind} Channel ${inbound.key}; ` +
          `its next message onboards it`,
      );
    }
  }

  /**
   * Retitles a renamed topic's Channel in a workspace, first renaming the
   * title in the `topics` of the one note claiming it; runs in the queue,
   * so no message routes between the two. The note is left as it is when
   * another Agent claims the new title already, and keeps the old title
   * too while another topic Pero knows has it.
   */
  private async renameInNotes(
    kind: IntegrationKind,
    inbound: InboundChannel,
  ): Promise<void> {
    const channels = this.dataSource.getRepository(Channel);
    const channel = await channels.findOneBy({
      integrationKind: kind,
      externalKey: inbound.key,
    });
    if (channel === null) {
      this.logger.debug(
        `Ignored the rename of unknown ${kind} Channel ${inbound.key}; ` +
          `its next message onboards it`,
      );
      return;
    }
    const from = channel.title?.trim() ?? '';
    const to = inbound.title?.trim() ?? '';
    const snapshot = await this.notes.ready();
    if (
      inbound.topicId !== null &&
      snapshot !== null &&
      from !== '' &&
      to !== '' &&
      from.toLowerCase() !== to.toLowerCase()
    ) {
      const claim = topicClaim(snapshot, from);
      const agent =
        claim.kind === 'agent' ? snapshot.agents.get(claim.agent) : undefined;
      const taken = topicClaim(snapshot, to);
      if (agent !== undefined && taken.kind === 'unclaimed') {
        const keep = (
          await channels.find({ where: { integrationKind: kind } })
        ).some(
          (other) =>
            other.id !== channel.id &&
            !routeQuery(other).primary &&
            other.title?.trim().toLowerCase() === from.toLowerCase(),
        );
        try {
          await this.agentNotes.renameTopic(agent.file, from, to, keep);
        } catch (error) {
          this.logger.warn(
            `Could not rename topic "${from}" in ${agent.file}: ${describe(error)}`,
          );
        }
      } else if (agent !== undefined) {
        this.logger.log(
          `Left ${agent.file} as it is: the renamed topic "${to}" is ` +
            (taken.kind === 'agent'
              ? `claimed by Agent ${taken.agent} already`
              : `claimed by other notes too`),
        );
      }
    }
    await channels.update(channel.id, { title: inbound.title });
  }

  /**
   * Moves a chat that now lives under a new ID, as when a group gains
   * topics: its primary Channel, whose key is the chat's, then its entry in
   * `config.yaml`. A chat that migrates has no topics yet, so no other
   * Channel has its key. Sessions and history follow the Channel's ID.
   */
  private async migrate(
    event: Extract<ChannelEvent, { type: 'chat-migrated' }>,
  ): Promise<void> {
    const { integrationKind, chat, newChatKey, newAddress } = event;
    if ((await this.allowedChats.find(integrationKind, chat.key)) === null) {
      return;
    }
    await inTransaction(this.dataSource, async (manager) => {
      const channels = manager.getRepository(Channel);
      const channel = await channels.findOneBy({
        integrationKind,
        externalKey: chat.key,
      });
      if (channel === null) return;
      if (
        await channels.existsBy({ integrationKind, externalKey: newChatKey })
      ) {
        this.logger.warn(
          `Kept ${integrationKind} Channel ${channel.id} under ${chat.key}: ` +
            `a Channel for the migrated chat ${newChatKey} already exists`,
        );
        return;
      }
      channel.externalKey = newChatKey;
      channel.address = { ...newAddress };
      await channels.save(channel);
    });
    try {
      this.allowedChats.migrate(integrationKind, chat.key, newChatKey);
    } catch (error) {
      this.logger.error(
        `Moved ${integrationKind} chat ${chat.key} to ${newChatKey}, but ` +
          `could not update config.yaml; allow ${newChatKey} again: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.logger.log(
      `Followed ${integrationKind} chat ${chat.key} to its new ID ${newChatKey}`,
    );
  }

  /** Sends Pero's own notice with `send`; a failure is only logged. */
  private async notify(
    kind: IntegrationKind,
    key: string,
    send: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.warn(
        `Failed to post in ${kind} Channel ${key}: ${describe(error)}`,
      );
    }
  }
}

function findChannel(
  manager: EntityManager,
  integrationKind: IntegrationKind,
  externalKey: string,
): Promise<Channel | null> {
  return manager
    .getRepository(Channel)
    .findOneBy({ integrationKind, externalKey });
}

/** The topic ID in a topic Channel's key, after the chat's. */
function topicIdOf(channel: Pick<Channel, 'externalKey'>): string {
  return channel.externalKey.slice(channel.externalKey.indexOf(':') + 1);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
