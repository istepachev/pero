import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { Channel } from '../persistence/entities/channel.entity.js';
import type { ChatKind, IntegrationKind } from '../persistence/entities/sql.js';
import { inTransaction } from '../persistence/transaction.js';
import { shownPath } from '../system-files/note-paths.js';
import {
  INSTRUCTIONS_NOTE,
  NOTE_FOLDERS,
  PERO_NOTE,
  PERSONA_NOTE,
} from '../system-files/note-files.js';
import {
  channelIdFor,
  type ChannelNote,
} from '../system-files/snapshot.js';
import { ChannelNotes } from '../system/channel-notes.service.js';
import {
  Definitions,
  type Route,
  routeQuery,
} from '../system/definitions.js';
import { SystemNotes } from '../system/system-notes.service.js';
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
 * Posted in a new Channel: how Pero answers there, and `note`, the file
 * that holds its settings and instructions, as the owner reads it.
 */
export function welcomeText(
  note: Pick<ChannelNote, 'provider' | 'model'>,
  folder: string,
  file: string,
  where: 'topic' | 'chat',
): string {
  return (
    `${whoAnswers(note, folder, where)} ` +
    `This ${where}'s settings and instructions are in ${file}: edit that ` +
    `note, or ask here to change them.`
  );
}

/** The notes and folders a new owner learns of, as they read them. */
export interface FirstStepsPaths {
  /** `Default.md`, the note of General topics and direct chats. */
  note: string;
  /** `Persona.md`, Pero's personality. */
  persona: string;
  /** `Instructions.md`, Pero's general instructions. */
  instructions: string;
  /** `Pero.md`, the defaults for every Channel and Workflow. */
  pero: string;
  /** The folder of Channel notes. */
  channels: string;
  /** The folder of Workflow notes. */
  workflows: string;
  /** The time zone schedules use now. */
  timezone: string;
}

/**
 * Posted in a chat's new primary Channel, so usually right after setup:
 * how Pero answers there, then what a new owner does first. A direct chat
 * (`private`) hears how to get topics; any other chat, how to use them.
 */
export function firstStepsText(
  note: Pick<ChannelNote, 'provider' | 'model'>,
  folder: string,
  paths: FirstStepsPaths,
  kind: ChatKind | null,
): string {
  const topics =
    kind === 'private'
      ? `2. Get a Channel per subject: create a private Telegram group, ` +
        `turn on Topics, add this bot as an administrator, and allow the ` +
        `group with pero telegram allow <chat-id>. Each topic there gets a ` +
        `note of its own in ${paths.channels}; its General topic is ` +
        `answered as this chat is, from ${paths.note}.`
      : `2. Create a topic for each subject, such as Health or a side ` +
        `project. Each new topic gets a note in ${paths.channels} named ` +
        `after it, for that topic's own instructions and settings; this ` +
        `chat's are in ${paths.note}.`;
  return [
    whoAnswers(note, folder, 'chat'),
    '',
    'First steps:',
    `1. Make it yours: Pero's personality is in ${paths.persona} and its ` +
      `instructions in ${paths.instructions}. Say who you are, how it ` +
      `should talk to you, and what it helps you with. Or just ask here, ` +
      `such as "be less formal" or "always answer in German".`,
    topics,
    `3. Schedules use the time zone ${paths.timezone}. Set yours, and ` +
      `defaults for every Channel such as the provider and model, in ` +
      `${paths.pero}.`,
    `4. Put Pero to work on a schedule: ask it, say, "every evening at 9, ` +
      `sum up what we talked about today". Workflows are notes in ` +
      `${paths.workflows}.`,
    '',
    'When Pero wants to run a command or change a setting, it asks here ' +
      'with Allow and Deny buttons. Pero reads edited notes within ' +
      'seconds. /help lists what Pero answers itself, such as /status and ' +
      '/new to start over.',
  ].join('\n');
}

/** How Pero answers in a Channel: with what, and where it works. */
function whoAnswers(
  note: Pick<ChannelNote, 'provider' | 'model'>,
  folder: string,
  where: 'topic' | 'chat',
): string {
  const { model } = note;
  return (
    `Pero answers in this ${where} with ${note.provider}, ` +
    `${model === null ? 'default model' : `model ${model}`}, ` +
    `working in ${folder}.`
  );
}

/**
 * Records each new Channel in an allowed chat, and welcomes it when Pero
 * answers there. The notes are matched on every message, and Pero writes
 * the note of a Channel that has none, binds a note named as its title
 * to it, and writes `Default.md` when a primary Channel finds none.
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
    private readonly notes: SystemNotes,
    private readonly channelNotes: ChannelNotes,
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
   * new, and welcoming it when Pero answers there.
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
   * How Pero answers in `channel` now, writing or binding its note when it
   * has none, and welcoming it when it is new or Pero wrote that note.
   * `chatKind` is its chat's, when known.
   */
  private async settle(
    channel: Channel,
    created: boolean,
    chatKind: ChatKind | null,
  ): Promise<Route> {
    let route = routeOf(channel, this.definitions);
    let wrote = false;
    if (route.kind === 'answered' && route.match !== 'note') {
      ({ route, wrote } = await this.serially(() => this.writeFor(channel)));
    }
    if (route.kind === 'answered' && (created || wrote)) {
      await this.welcome(channel, route.note, chatKind);
    }
    return route;
  }

  /**
   * Writes the note `channel` uses, or binds the one named as its title to
   * it, unless that happened while this waited its turn; runs in the
   * queue. Where writing fails, the Channel goes on with the defaults.
   */
  private async writeFor(
    channel: Channel,
  ): Promise<{ route: Route; wrote: boolean }> {
    const route = routeOf(channel, this.definitions);
    if (route.kind !== 'answered' || route.match === 'note') {
      return { route, wrote: false };
    }
    const query = routeQuery(channel);
    let file: string | null;
    try {
      if (route.match === 'bindable') {
        const bound = await this.channelNotes.bind(
          route.note.file!,
          query.channelId,
        );
        file = bound ? route.note.file : null;
      } else if (query.primary) {
        file = await this.channelNotes.createDefault();
      } else {
        file = await this.channelNotes.createFor(
          query.channelId,
          channel.title?.trim() ?? '',
          topicIdOf(channel),
        );
      }
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
        `Wrote ${file}, but Pero doesn't answer in ${channel.integrationKind} ` +
          `Channel ${channel.externalKey}: ${unansweredSummary(after.reason)}`,
      );
    } else {
      this.logger.log(
        `${channel.integrationKind} Channel ${channel.externalKey} is ` +
          `answered from ${file}`,
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
    note: ChannelNote,
    chatKind: ChatKind | null,
  ): Promise<void> {
    if (this.welcomed.has(channel.id)) return;
    this.welcomed.add(channel.id);
    const { workspace, systemFolder } = this.notes.folders();
    const shown = (path: string) =>
      shownPath(workspace, join(systemFolder, path));
    const file = note.file === null ? '(no note yet)' : shown(note.file);
    const text = routeQuery(channel).primary
      ? firstStepsText(
          note,
          note.workingDirectory,
          {
            note: file,
            persona: shown(PERSONA_NOTE),
            instructions: shown(INSTRUCTIONS_NOTE),
            pero: shown(PERO_NOTE),
            channels: `${shown(NOTE_FOLDERS.channel)}/`,
            workflows: `${shown(NOTE_FOLDERS.workflow)}/`,
            timezone: this.definitions.defaults().timezone,
          },
          chatKind,
        )
      : welcomeText(note, note.workingDirectory, file, 'topic');
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
   * Retitles a renamed topic's Channel. Its note keeps its name: it is
   * bound to the Channel by `channel-id`, and Workflows name it.
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
    await channels.update(channel.id, { title: inbound.title });
  }

  /**
   * Moves a chat that now lives under a new ID, as when a group gains
   * topics: its primary Channel, whose key is the chat's, its entry in
   * `config.yaml`, then the `channel-id` of its notes. A chat that
   * migrates has no topics yet, so no other Channel has its key. Sessions
   * and history follow the Channel's ID.
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
    try {
      await this.serially(() =>
        this.channelNotes.rebindChat(
          channelIdFor(integrationKind, chat.key),
          channelIdFor(integrationKind, newChatKey),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Could not move the notes of ${integrationKind} chat ${chat.key} ` +
          `to ${newChatKey}; set their channel-id by hand: ${describe(error)}`,
      );
    }
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
