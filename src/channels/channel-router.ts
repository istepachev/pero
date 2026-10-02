import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type {
  ActionResult,
  ChannelAdapter,
  ChannelAddress,
  ChannelEvent,
  InboundAction,
  InboundChat,
  InboundMessage,
} from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import { ChannelCommands } from './commands/channel-commands.service.js';
import { buttonCommand, isCommand } from './commands/command-list.js';
import {
  ChannelOnboarding,
  ChannelTurns,
  type RoutedChannel,
} from './channel-stages.js';
import { InboundUpdates } from './inbound-updates.service.js';
import { type PairingHint, PairingRequests } from './pairing-requests.js';
import { ToolApprovals } from './tool-approvals.js';
import { UnansweredReplies } from './unanswered-replies.js';

/**
 * The reply a chat that is not allowed gets, each hint at most once an
 * hour: how to pair it in a terminal on the host, or, while `pero run`
 * waits for a chat there, to confirm it in that terminal. Pero's own
 * text, never a model's: no runtime answers a chat that is not allowed.
 */
export function pairingHint(
  kind: IntegrationKind,
  chatKey: string,
  hint: PairingHint = 'allow',
): string {
  return hint === 'confirm'
    ? `Pero sees this chat (ID ${chatKey}). To pair it, confirm in the ` +
        `terminal where pero run asks to allow it.`
    : `This chat isn't paired with Pero yet (ID ${chatKey}). To pair it, ` +
        `run in a terminal on the Pero host: pero ${kind} allow ${chatKey}`;
}

/**
 * Takes every update from the connected adapters. Only allowed chats get
 * past it, each update only once; a message then joins its Channel's
 * history and is answered with the Channel's note, through onboarding
 * first when its Channel is new. Where no one answers, Pero says why once.
 */
@Injectable()
export class ChannelRouter implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Channels');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sender: ChannelSender,
    private readonly allowedChats: AllowedChatsService,
    private readonly inboundUpdates: InboundUpdates,
    private readonly pairing: PairingRequests,
    private readonly turns: ChannelTurns,
    private readonly onboarding: ChannelOnboarding,
    private readonly history: MessageHistory,
    private readonly approvals: ToolApprovals,
    private readonly unanswered: UnansweredReplies,
    private readonly commands: ChannelCommands,
  ) {}

  /** Starts `adapter`'s intake into this router and sends through it. */
  async connect(adapter: ChannelAdapter): Promise<void> {
    this.sender.add(adapter);
    await adapter.start({
      onMessage: (message) => this.handleMessage(message),
      onEvent: (event) => this.handleEvent(event),
      onAction: (action) => this.handleAction(action),
    });
  }

  /**
   * Stops intake, then lets accepted turns finish or ends them, all before
   * the database closes. Tool requests are denied at once, since no answer
   * can arrive any more.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.sender.all().map(async (adapter) => {
        try {
          await adapter.stop();
        } catch (error) {
          this.logger.error(
            `Failed to stop the ${adapter.kind} adapter: ${describe(error)}`,
          );
        }
      }),
    );
    this.approvals.closeAll();
    await this.turns.drain();
  }

  /** Routes one message; failures are logged, never thrown at the adapter. */
  async handleMessage(message: InboundMessage): Promise<void> {
    const { integrationKind: kind, updateId } = message;
    try {
      if (!(await this.admit(kind, message.chat, message.channel.address))) {
        return;
      }
      if (!(await this.claim(kind, updateId))) return;
      const command = message.content.command;
      if (command !== undefined && isCommand(command.name)) {
        // Pero's own business: neither the command nor its answer joins
        // the history, and no turn sees them.
        const channel = await this.channelOf(message);
        await this.inboundUpdates.markProcessed(kind, updateId);
        if (channel === null) return;
        await this.commands.run(
          channel,
          await this.onboarding.answer(channel),
          command,
        );
        return;
      }
      const channel = await this.route(message);
      if (channel === null) {
        await this.inboundUpdates.markProcessed(kind, updateId);
        return;
      }
      // Recorded as its update is handed on, so a message a turn gets is
      // in the history, and a redelivered one never is twice.
      const messageId = await this.inboundUpdates.markProcessed(
        kind,
        updateId,
        (manager) =>
          this.history.recordInboundWithin(manager, {
            channelId: channel.id,
            agentName: channel.note.name,
            externalMessageId: message.messageId,
            senderId: message.senderId,
            text: message.content.text,
          }),
      );
      await this.turns.handle(channel, message, messageId);
    } catch (error) {
      this.logger.error(
        `Failed to route ${kind} update ${updateId}: ${describe(error)}`,
      );
    }
  }

  /** Routes one event; failures are logged, never thrown at the adapter. */
  async handleEvent(event: ChannelEvent): Promise<void> {
    const { integrationKind: kind, updateId, chat } = event;
    try {
      // Of the events in a chat that is not allowed, only the bot joining
      // it earns the hint; the rest are dropped quietly.
      const joined =
        event.type === 'membership-changed' && event.status !== 'left';
      if (!(await this.admit(kind, chat, joined ? chat.address : null))) {
        return;
      }
      await this.once(kind, updateId, () => this.onboarding.onEvent(event));
    } catch (error) {
      this.logger.error(
        `Failed to route ${kind} ${event.type} update ${updateId}: ${describe(error)}`,
      );
    }
  }

  /**
   * Answers a pressed button: a command's, whose ID is the command, or a
   * tool request's. Only an allowed chat's presses count; they need no
   * deduplication, since pressing again only does the same thing again.
   */
  async handleAction(action: InboundAction): Promise<ActionResult> {
    const { integrationKind: kind, updateId } = action;
    try {
      if (!(await this.admit(kind, action.chat, null))) {
        return { notice: "This chat isn't allowed to use Pero" };
      }
      if (buttonCommand(action.actionId) !== null) {
        const channel = await this.dataSource.getRepository(Channel).findOneBy({
          integrationKind: kind,
          externalKey: action.channel.key,
        });
        if (channel === null) return { notice: 'This menu has expired' };
        return await this.commands.press(
          channel,
          await this.onboarding.answer(channel),
          action,
        );
      }
      return await this.approvals.onAction(action);
    } catch (error) {
      this.logger.error(
        `Failed to route ${kind} button press ${updateId}: ${describe(error)}`,
      );
      return { notice: null };
    }
  }

  /**
   * Whether `chat` is allowed. A chat that is not gets the pairing hint at
   * `hintAt`, when given and not sent lately, and leaves no other trace in
   * the database.
   */
  private async admit(
    kind: IntegrationKind,
    chat: InboundChat,
    hintAt: ChannelAddress | null,
  ): Promise<boolean> {
    const allowed = await this.allowedChats.find(kind, chat.key);
    if (allowed === null) {
      if (hintAt !== null) await this.turnAway(kind, chat, hintAt);
      return false;
    }
    await this.allowedChats.refreshTitle(allowed, chat.title);
    return true;
  }

  /**
   * The Channel `message` goes to, onboarding it when new, with the note
   * Pero answers there with now; null, after saying why once, when it
   * doesn't answer there.
   * The route follows the notes on every message, so it isn't stored.
   */
  private async route(message: InboundMessage): Promise<RoutedChannel | null> {
    const channel = await this.channelOf(message);
    if (channel === null) return null;
    const route = await this.onboarding.answer(channel);
    if (route.kind === 'unanswered') {
      await this.unanswered.explain(channel, route.reason);
      return null;
    }
    this.unanswered.answered(channel.id);
    return Object.assign(channel, { note: route.note });
  }

  /**
   * The Channel `message` belongs to, onboarding it when new and learning
   * its title; null when none could be set up yet.
   */
  private async channelOf(message: InboundMessage): Promise<Channel | null> {
    const repository = this.dataSource.getRepository(Channel);
    const channel = await repository.findOneBy({
      integrationKind: message.integrationKind,
      externalKey: message.channel.key,
    });
    if (channel === null) return this.onboarding.onUnknownChannel(message);
    if (learnsTitle(channel, message.channel)) {
      await repository.update(channel.id, { title: message.channel.title });
      channel.title = message.channel.title;
    }
    return channel;
  }

  /** Runs `work` for an update seen for the first time. */
  private async once(
    kind: IntegrationKind,
    updateId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    if (!(await this.claim(kind, updateId))) return;
    await work();
    await this.inboundUpdates.markProcessed(kind, updateId);
  }

  /** Claims an update; false, after a note in the log, for a duplicate. */
  private async claim(
    kind: IntegrationKind,
    updateId: string,
  ): Promise<boolean> {
    const claimed = await this.inboundUpdates.claim(kind, updateId);
    if (!claimed) {
      this.logger.debug(`Skipped duplicate ${kind} update ${updateId}`);
    }
    return claimed;
  }

  private async turnAway(
    kind: IntegrationKind,
    chat: InboundChat,
    replyTo: ChannelAddress,
  ): Promise<void> {
    const { hint } = this.pairing.record(kind, chat);
    if (hint === null) return;
    this.logger.log(
      `A ${kind} chat that is not allowed asked to pair: ${chat.key}`,
    );
    try {
      await this.sender.send(kind, replyTo, {
        text: pairingHint(kind, chat.key, hint),
      });
    } catch (error) {
      this.logger.warn(
        `Failed to send the pairing hint to ${kind} chat ${chat.key}: ${describe(error)}`,
      );
    }
  }
}

/**
 * Whether `inbound` tells `channel` a title it doesn't have: a chat's
 * current title, or the title of a topic first seen in a reply, which
 * carries none. A topic's messages carry the title it was created with,
 * so a known one changes only when the topic is renamed.
 */
function learnsTitle(
  channel: Pick<Channel, 'title'>,
  inbound: InboundMessage['channel'],
): boolean {
  if (inbound.title === null || inbound.title === channel.title) return false;
  return inbound.topicId === null || channel.title === null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
