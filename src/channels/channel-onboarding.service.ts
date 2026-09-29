import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { effectiveWorkingDirectory } from '../agents/agent-resolution.js';
import { AgentsService } from '../agents/agents.service.js';
import { InvalidInputError } from '../common/errors.js';
import { SLUG_MAX_LENGTH } from '../config/slug.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
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
import { ChannelOnboarding, type RoutedChannel } from './channel-stages.js';

/** The Agent primary Channels get while the `main-agent` setting is unset. */
export const MAIN_AGENT_NAME = 'main';

/** Posted in a new Channel: who answers there and how to change it. */
export function welcomeText(
  agent: Pick<Agent, 'name' | 'provider' | 'providerOptions'>,
  folder: string,
  where: 'topic' | 'chat',
): string {
  const { model } = agent.providerOptions;
  return (
    `This ${where} talks to Agent ${agent.name}: ${agent.provider}, ` +
    `${model === null ? 'default model' : `model ${model}`}, ` +
    `working in ${folder}. ` +
    `To change it, run on the Pero host: pero agents edit ${agent.name}`
  );
}

/** Posted instead of a welcome when no Agent can be created yet. */
export function setupHint(reason: string): string {
  return (
    `Pero can't set up an Agent here yet. ${reason}. ` +
    `To choose the folder Agents work in, run on the Pero host: ` +
    `pero settings set default-working-directory <folder>`
  );
}

const NO_DEFAULT_FOLDER = 'No default working directory is set';

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

    let result: { channel: RoutedChannel; welcome: string | null };
    try {
      result = await inTransaction(this.dataSource, async (manager) => {
        const existing = await findChannel(manager, kind, inbound.key);
        if (existing !== null) return { channel: existing, welcome: null };

        const settings = await getSettings(manager);
        const agent =
          name === null
            ? await this.mainAgent(manager, settings)
            : await this.newAgent(manager, settings, {
                name: await uniqueName(manager, name),
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
          welcome: welcomeText(
            agent,
            effectiveWorkingDirectory(agent, settings),
            name === null ? 'chat' : 'topic',
          ),
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

    const { channel, welcome } = result;
    if (welcome !== null) {
      this.logger.log(
        `Onboarded ${kind} Channel ${inbound.key} with Agent ${channel.agent.name}`,
      );
      await this.notify(kind, inbound, () =>
        this.sender.post(channel, welcome, { origin: 'pero' }),
      );
    }
    return channel;
  }

  /** The Agent that `settings.mainAgentId` names, recording `main` first. */
  private async mainAgent(
    manager: EntityManager,
    settings: Settings,
  ): Promise<Agent> {
    const agents = manager.getRepository(Agent);
    if (settings.mainAgentId !== null) {
      return agents.findOneByOrFail({ id: settings.mainAgentId });
    }
    // An Agent the owner already named `main` becomes the main Agent.
    const agent =
      (await agents.findOneBy({ name: MAIN_AGENT_NAME })) ??
      (await this.newAgent(manager, settings, { name: MAIN_AGENT_NAME }));
    await manager
      .getRepository(Settings)
      .update(SETTINGS_ID, { mainAgentId: agent.id });
    return agent;
  }

  /** An Agent with the installation defaults, following the default folder. */
  private newAgent(
    manager: EntityManager,
    settings: Settings,
    fields: { name: string; title?: string | null },
  ): Promise<Agent> {
    if (settings.defaultWorkingDirectory === null) {
      throw new InvalidInputError(NO_DEFAULT_FOLDER);
    }
    return this.agents.createWithin(manager, fields);
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
      if (inbound.topicId !== null && channel.agent.title === channel.title) {
        await manager
          .getRepository(Agent)
          .update(channel.agentId, { title: inbound.title });
      }
      await manager
        .getRepository(Channel)
        .update(channel.id, { title: inbound.title });
      return true;
    });
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

async function findChannel(
  manager: EntityManager,
  integrationKind: IntegrationKind,
  externalKey: string,
): Promise<RoutedChannel | null> {
  const channel = await manager.getRepository(Channel).findOne({
    where: { integrationKind, externalKey },
    relations: { agent: true },
  });
  // The foreign key guarantees the Agent.
  return channel as RoutedChannel | null;
}

function getSettings(manager: EntityManager): Promise<Settings> {
  return manager.getRepository(Settings).findOneByOrFail({ id: SETTINGS_ID });
}

/** `base`, or `base-2`, `base-3`, … when taken, cut to fit a slug. */
async function uniqueName(
  manager: EntityManager,
  base: string,
): Promise<string> {
  const agents = manager.getRepository(Agent);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const stem = base
      .slice(0, SLUG_MAX_LENGTH - suffix.length)
      .replace(/-$/, '');
    const name = stem + suffix;
    if (!(await agents.existsBy({ name }))) return name;
  }
}
