import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AgentsService, MAIN_AGENT_NAME } from '../agents/agents.service.js';
import { InvalidInputError } from '../common/errors.js';
import { DefinitionIds } from '../definitions/definition-ids.js';
import {
  type AgentDefinition,
  Definitions,
} from '../definitions/definitions.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import { inTransaction } from '../persistence/transaction.js';
import { AgentNamer } from './agent-namer.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type {
  ChannelEvent,
  InboundChannel,
  InboundMessage,
} from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import {
  assignedAgent,
  ChannelOnboarding,
  type RoutedChannel,
  undefinedAgentHint,
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
 * Gives each new Channel in an allowed chat its Agent: a topic gets a new
 * one named after it, and a chat's primary Channel gets the main Agent.
 * An existing Channel keeps its assignment; a renamed topic changes titles
 * only.
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
    private readonly ids: DefinitionIds,
  ) {
    super();
  }

  onUnknownChannel(message: InboundMessage): Promise<RoutedChannel | null> {
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
   * The Channel for `inbound`, creating it and its Agent in one transaction
   * and welcoming it when new. Null, after a hint in the Channel, when its
   * Agent cannot be created yet; the next attempt tries again.
   */
  private async onboard(
    kind: IntegrationKind,
    inbound: InboundChannel,
  ): Promise<RoutedChannel | null> {
    // Named before the transaction: a namer may be slow, and the
    // transaction queue must not wait on it.
    const name =
      inbound.topicId === null ? null : await this.namer.suggest(inbound);
    // In a workspace, `Pero.md` names the main Agent, whether or not its
    // note exists yet.
    const main =
      inbound.topicId === null ? await this.definitions.mainAgentName() : null;

    let result: { channel: Channel; created: boolean };
    try {
      result = await inTransaction(this.dataSource, async (manager) => {
        const existing = await findChannel(manager, kind, inbound.key);
        if (existing !== null) return { channel: existing, created: false };

        const agent =
          name === null
            ? main === null
              ? await this.agents.mainAgentWithin(manager)
              : await this.agents.anchorWithin(manager, main)
            : await this.agents.createForTopicWithin(manager, {
                base: name,
                title: inbound.title,
              });
        const channels = manager.getRepository(Channel);
        await channels.save(
          channels.create({
            integrationKind: kind,
            externalKey: inbound.key,
            address: { ...inbound.address },
            title: inbound.title,
            agentId: agent.id,
          }),
        );
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

    if (result.created) this.agents.committed();
    const { name: agentName, agent } = await assignedAgent(
      result.channel,
      this.definitions,
      this.ids,
    );
    if (agent === null) {
      // Until onboarding writes notes (plan step 8.3).
      this.logger.warn(
        `${kind} Channel ${inbound.key} gets no answer yet: ` +
          undefinedAgentHint(agentName),
      );
      return null;
    }
    const channel = Object.assign(result.channel, { agent });
    if (result.created) {
      this.logger.log(
        `Onboarded ${kind} Channel ${inbound.key} with Agent ${channel.agent.name}`,
      );
      const welcome = welcomeText(
        channel.agent,
        channel.agent.workingDirectory,
        inbound.topicId === null ? 'chat' : 'topic',
      );
      await this.notify(kind, inbound, () =>
        this.sender.post(channel, welcome, { origin: 'pero' }),
      );
    }
    return channel;
  }

  /**
   * Retitles a renamed topic's Channel, and its Agent while the Agent's
   * title still mirrors the topic's; never the Agent's name.
   */
  private async rename(
    kind: IntegrationKind,
    inbound: InboundChannel,
  ): Promise<void> {
    const found = await inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, kind, inbound.key);
      if (channel === null) return false;
      if (inbound.topicId !== null) {
        await this.agents.retitleWithin(
          manager,
          channel.agentId,
          channel.title,
          inbound.title,
        );
      }
      await manager
        .getRepository(Channel)
        .update(channel.id, { title: inbound.title });
      return true;
    });
    if (found && inbound.topicId !== null) this.agents.committed();
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
