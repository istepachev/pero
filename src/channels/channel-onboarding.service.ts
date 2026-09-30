import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AgentsService, MAIN_AGENT_NAME } from '../agents/agents.service.js';
import { InvalidInputError } from '../common/errors.js';
import {
  type AgentDefinition,
  Definitions,
} from '../definitions/definitions.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { LegacyChannelAgent } from '../persistence/entities/legacy-channel-agent.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import { inTransaction } from '../persistence/transaction.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { AgentNamer } from './agent-namer.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type {
  ChannelEvent,
  InboundChannel,
  InboundMessage,
} from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import { ChannelOnboarding, routeOf } from './channel-stages.js';

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
 * message. A legacy data directory still assigns one: a topic gets a new
 * Agent named after it, and a chat's primary Channel the main Agent. A
 * renamed topic changes titles only.
 */
@Injectable()
export class ChannelOnboardingService extends ChannelOnboarding {
  private readonly logger = new Logger('Channels');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly agents: AgentsService,
    private readonly namer: AgentNamer,
    private readonly sender: ChannelSender,
    private readonly allowedChats: AllowedChatsService,
    private readonly definitions: Definitions,
    private readonly notes: SettingsNotes,
  ) {
    super();
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
      await this.notify(kind, inbound, () =>
        this.sender.send(kind, inbound.address, {
          text: setupHint(error.message),
        }),
      );
      return null;
    }

    const { channel, created } = result;
    if (!created) return channel;
    if (legacy) this.agents.committed();
    const route = await routeOf(channel, this.definitions);
    if (route.kind === 'unanswered') {
      // The message that onboarded it, if any, is told why.
      this.logger.log(`Onboarded ${kind} Channel ${inbound.key}`);
      return channel;
    }
    this.logger.log(
      `Onboarded ${kind} Channel ${inbound.key}, answered by Agent ${route.agent.name}`,
    );
    const welcome = welcomeText(
      route.agent,
      route.agent.workingDirectory,
      inbound.topicId === null ? 'chat' : 'topic',
    );
    await this.notify(kind, inbound, () =>
      this.sender.post(channel, welcome, { origin: 'pero' }),
    );
    return channel;
  }

  /**
   * Retitles a renamed topic's Channel, which may move the topic to the
   * Agent claiming its new title. In a legacy data directory, it retitles
   * the topic's Agent too while the Agent's title still mirrors the
   * topic's; never the Agent's name.
   */
  private async rename(
    kind: IntegrationKind,
    inbound: InboundChannel,
  ): Promise<void> {
    const legacy = !this.notes.inWorkspace();
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
    inbound: InboundChannel,
    send: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.warn(
        `Failed to post in ${kind} Channel ${inbound.key}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
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
