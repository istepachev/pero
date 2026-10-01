import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { Channel } from '../persistence/entities/channel.entity.js';
import type { ChatKind, IntegrationKind } from '../persistence/entities/sql.js';
import { inTransaction } from '../persistence/transaction.js';
import { shownPath } from '../settings-files/note-paths.js';
import { type Agent, topicClaim } from '../settings-files/snapshot.js';
import { AgentNotes } from '../settings/agent-notes.service.js';
import {
  Definitions,
  type Route,
  routeQuery,
  type Unanswered,
} from '../settings/definitions.js';
import { SettingsNotes } from '../settings/settings-notes.service.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type {
  ChannelEvent,
  InboundChannel,
  InboundChat,
  InboundMessage,
} from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import {
  ChannelOnboarding,
  routeOf,
  unansweredSummary,
} from './channel-stages.js';

/**
 * Posted in a new Channel: who answers there, and `note`, the file that
 * holds its settings and instructions, as the owner reads it.
 */
export function welcomeText(
  agent: Pick<Agent, 'name' | 'provider' | 'model'>,
  folder: string,
  note: string,
  where: 'topic' | 'chat',
): string {
  return (
    `${whoAnswers(agent, folder, where)} ` +
    `Its settings and instructions are in ${note}: edit that note, ` +
    `or ask here to change them.`
  );
}

/** The notes and folders a new owner learns of, as they read them. */
export interface FirstStepsPaths {
  /** The main Agent's note. */
  note: string;
  /** `Pero.md`, the defaults for every Agent and Workflow. */
  pero: string;
  /** The folder of Agent notes. */
  agents: string;
  /** The folder of Workflow notes. */
  workflows: string;
  /** The time zone schedules use now. */
  timezone: string;
}

/**
 * Posted in a chat's new primary Channel, where the main Agent answers,
 * so usually right after setup: who answers there, then what a new owner
 * does first. A direct chat (`private`) hears how to get topics; any other
 * chat, how to use them.
 */
export function firstStepsText(
  agent: Pick<Agent, 'name' | 'provider' | 'model'>,
  folder: string,
  paths: FirstStepsPaths,
  kind: ChatKind | null,
): string {
  const topics =
    kind === 'private'
      ? `2. Get an Agent per subject: create a private Telegram group, ` +
        `turn on Topics, add this bot as an administrator, and allow the ` +
        `group with pero telegram allow <chat-id>. Each topic there gets an ` +
        `Agent of its own; its General topic talks to this one.`
      : `2. Create a topic for each subject, such as Health or a side ` +
        `project. Each new topic gets an Agent of its own, with a note in ` +
        `${paths.agents} named after the topic. Every topic's Agent starts ` +
        `with this Agent's instructions, then adds its own.`;
  return [
    whoAnswers(agent, folder, 'chat'),
    '',
    'First steps:',
    `1. Make it yours: this Agent's personality and instructions are in ` +
      `${paths.note}. ` +
      `Say who you are, how it should talk to you, and what it helps you ` +
      `with. Or just ask here, such as "be less formal" or "always answer ` +
      `in German".`,
    topics,
    `3. Schedules use the time zone ${paths.timezone}. Set yours, and ` +
      `defaults for every Agent such as the provider and model, in ` +
      `${paths.pero}.`,
    `4. Put an Agent to work on a schedule: ask it, say, "every evening at ` +
      `9, sum up what we talked about today". Workflows are notes in ` +
      `${paths.workflows}.`,
    '',
    'When an Agent wants to run a command or change a setting, it asks ' +
      'here with Allow and Deny buttons. Pero reads edited notes within ' +
      'seconds.',
  ].join('\n');
}

/** Who answers in a Channel, with what, and where it works. */
function whoAnswers(
  agent: Pick<Agent, 'name' | 'provider' | 'model'>,
  folder: string,
  where: 'topic' | 'chat',
): string {
  const { model } = agent;
  return (
    `This ${where} talks to Agent ${agent.name}: ${agent.provider}, ` +
    `${model === null ? 'default model' : `model ${model}`}, ` +
    `working in ${folder}.`
  );
}

/**
 * Records each new Channel in an allowed chat, and welcomes it when an
 * Agent answers there. Notes choose that Agent on every message, and Pero
 * writes the note that answers a topic no Agent claims and the main
 * Agent's when a primary Channel finds none; a renamed topic's title
 * follows in the note that claims it.
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
    private readonly sender: ChannelSender,
    private readonly allowedChats: AllowedChatsService,
    private readonly definitions: Definitions,
    private readonly notes: SettingsNotes,
    private readonly agentNotes: AgentNotes,
  ) {
    super();
  }

  answer(channel: Channel): Promise<Route> {
    return this.settle(channel, false, null);
  }

  onUnknownChannel(message: InboundMessage): Promise<Channel | null> {
    return this.onboard(
      message.integrationKind,
      message.channel,
      message.chat.kind,
    );
  }

  async onChatAllowed(kind: IntegrationKind, chat: InboundChat): Promise<void> {
    await this.onboard(
      kind,
      {
        key: chat.key,
        title: chat.title,
        address: chat.address,
        topicId: null,
      },
      chat.kind,
    );
  }

  async onEvent(event: ChannelEvent): Promise<void> {
    switch (event.type) {
      case 'topic-created':
        await this.onboard(
          event.integrationKind,
          event.channel,
          event.chat.kind,
        );
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
   * The Channel for `inbound`, in a chat of `chatKind`, creating it when
   * new, and welcoming it when an Agent answers there.
   */
  private async onboard(
    kind: IntegrationKind,
    inbound: InboundChannel,
    chatKind: ChatKind,
  ): Promise<Channel | null> {
    const { channel, created } = await inTransaction(
      this.dataSource,
      async (manager) => {
        const existing = await findChannel(manager, kind, inbound.key);
        if (existing !== null) return { channel: existing, created: false };
        const channels = manager.getRepository(Channel);
        await channels.save(
          channels.create({
            integrationKind: kind,
            externalKey: inbound.key,
            address: { ...inbound.address },
            title: inbound.title,
          }),
        );
        return {
          channel: (await findChannel(manager, kind, inbound.key))!,
          created: true,
        };
      },
    );
    if (!created) return channel;
    this.logger.log(`Onboarded ${kind} Channel ${inbound.key}`);
    await this.settle(channel, true, chatKind);
    return channel;
  }

  /**
   * Who answers in `channel` now, writing the note that answers it when
   * Pero should, and welcoming it when it is new or Pero wrote that note.
   * `chatKind` is its chat's, when known.
   */
  private async settle(
    channel: Channel,
    created: boolean,
    chatKind: ChatKind | null,
  ): Promise<Route> {
    let route = routeOf(channel, this.definitions);
    let wrote = false;
    if (route.kind === 'unanswered' && this.writesFor(channel, route.reason)) {
      ({ route, wrote } = await this.serially(() => this.writeFor(channel)));
    }
    if (route.kind === 'agent' && (created || wrote)) {
      await this.welcome(channel, route.agent, chatKind);
    }
    return route;
  }

  /**
   * Whether Pero writes a note where no one answers for `reason`: a topic
   * no Agent claims, or a primary Channel without the main Agent's note.
   */
  private writesFor(channel: Channel, reason: Unanswered): boolean {
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
    const route = routeOf(channel, this.definitions);
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
    const after = routeOf(channel, this.definitions);
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

  /**
   * Posts the welcome in `channel`, once while Pero runs: in a primary
   * Channel, the first steps for its chat of `chatKind`.
   */
  private async welcome(
    channel: Channel,
    agent: Agent,
    chatKind: ChatKind | null,
  ): Promise<void> {
    if (this.welcomed.has(channel.id)) return;
    this.welcomed.add(channel.id);
    const { workspace, settingsFolder } = this.notes.folders();
    const shown = (path: string) =>
      shownPath(workspace, join(settingsFolder, path));
    const note = shown(agent.file);
    const text = routeQuery(channel).primary
      ? firstStepsText(
          agent,
          agent.workingDirectory,
          {
            note,
            pero: shown('Pero.md'),
            agents: `${shown('Agents')}/`,
            workflows: `${shown('Workflows')}/`,
            timezone: this.definitions.defaults().timezone,
          },
          chatKind,
        )
      : welcomeText(agent, agent.workingDirectory, note, 'topic');
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
   * Retitles a renamed topic's Channel, first setting the `topic` of the
   * one note claiming it to the new title; runs in the queue, so no message
   * routes between the two. The note is left as it is when another Agent
   * claims the new title already, or while another topic Pero knows has the
   * old title, which then keeps the Agent.
   */
  private rename(
    kind: IntegrationKind,
    inbound: InboundChannel,
  ): Promise<void> {
    return this.serially(() => this.retitle(kind, inbound));
  }

  private async retitle(
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
    const snapshot = this.notes.snapshot();
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
      const shared =
        agent !== undefined &&
        (await channels.find({ where: { integrationKind: kind } })).some(
          (other) =>
            other.id !== channel.id &&
            !routeQuery(other).primary &&
            other.title?.trim().toLowerCase() === from.toLowerCase(),
        );
      if (agent !== undefined && shared) {
        this.logger.log(
          `Left ${agent.file} as it is: another topic is still titled "${from}"`,
        );
      } else if (agent !== undefined && taken.kind === 'unclaimed') {
        try {
          await this.agentNotes.renameTopic(agent.file, from, to);
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
