import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { Channel } from '../persistence/entities/channel.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type {
  ChannelAdapter,
  ChannelAddress,
  ChannelEvent,
  InboundChat,
  InboundMessage,
} from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import {
  ChannelOnboarding,
  ChannelTurns,
  type RoutedChannel,
} from './channel-stages.js';
import { InboundUpdates } from './inbound-updates.service.js';
import { PairingRequests } from './pairing-requests.js';

/** The reply a chat that is not allowed gets, at most once an hour. */
export function pairingHint(kind: IntegrationKind, chatKey: string): string {
  return (
    `This chat isn't allowed to use Pero yet. Its chat ID is ${chatKey}. ` +
    `To allow it, run on the Pero host: pero ${kind} allow ${chatKey}`
  );
}

/**
 * Takes every update from the connected adapters. Only allowed chats get
 * past it, each update only once; a message then goes to its Channel's
 * Agent, through onboarding first when its Channel is new.
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
  ) {}

  /** Starts `adapter`'s intake into this router and sends through it. */
  async connect(adapter: ChannelAdapter): Promise<void> {
    this.sender.add(adapter);
    await adapter.start({
      onMessage: (message) => this.handleMessage(message),
      onEvent: (event) => this.handleEvent(event),
    });
  }

  /** Stops intake before active work drains and the database closes. */
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
  }

  /** Routes one message; failures are logged, never thrown at the adapter. */
  async handleMessage(message: InboundMessage): Promise<void> {
    const { integrationKind: kind, updateId } = message;
    try {
      if (!(await this.admit(kind, message.chat, message.channel.address))) {
        return;
      }
      await this.once(kind, updateId, async () => {
        const channel =
          (await this.dataSource.getRepository(Channel).findOne({
            where: { integrationKind: kind, externalKey: message.channel.key },
            relations: { agent: true },
          })) ?? (await this.onboarding.onUnknownChannel(message));
        if (channel === null) return;
        if (!channel.enabled || !channel.agent?.enabled) {
          this.logger.debug(
            `Ignored ${kind} update ${updateId}: Channel ${channel.id} or ` +
              `its Agent is disabled`,
          );
        } else {
          await this.turns.handle(channel as RoutedChannel, message);
        }
      });
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

  /** Runs `work` for an update seen for the first time. */
  private async once(
    kind: IntegrationKind,
    updateId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    if (!(await this.inboundUpdates.claim(kind, updateId))) {
      this.logger.debug(`Skipped duplicate ${kind} update ${updateId}`);
      return;
    }
    await work();
    await this.inboundUpdates.markProcessed(kind, updateId);
  }

  private async turnAway(
    kind: IntegrationKind,
    chat: InboundChat,
    replyTo: ChannelAddress,
  ): Promise<void> {
    const { hint } = this.pairing.record(kind, chat);
    if (!hint) return;
    this.logger.log(
      `A ${kind} chat that is not allowed asked to pair: ${chat.key}`,
    );
    try {
      await this.sender.send(kind, replyTo, {
        text: pairingHint(kind, chat.key),
      });
    } catch (error) {
      this.logger.warn(
        `Failed to send the pairing hint to ${kind} chat ${chat.key}: ${describe(error)}`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
