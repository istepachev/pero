import { Injectable, Logger } from '@nestjs/common';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { PairingRequests } from '../channels/pairing-requests.js';
import { NotFoundError } from '../common/errors.js';
import type {
  AllowedChatView,
  TelegramChats as TelegramChatsView,
} from '../control/protocol.js';
import type { AllowedChat } from '../persistence/entities/allowed-chat.entity.js';
import { TelegramAdapter } from './telegram-adapter.js';
import { TelegramStatus } from './telegram-status.js';

/** How long allowing waits for the bot's standing in the chat. */
const CHECK_WAIT_MS = 2_000;

/**
 * The owner's view of the Telegram allowlist: which chats Pero serves,
 * which asked to pair, and allowing or denying one. Reached only through
 * the control endpoint on the host, never from a Telegram message.
 */
@Injectable()
export class TelegramChats {
  private readonly logger = new Logger('Telegram');

  constructor(
    private readonly allowedChats: AllowedChatsService,
    private readonly pairing: PairingRequests,
    private readonly adapter: TelegramAdapter,
    private readonly status: TelegramStatus,
  ) {}

  async list(): Promise<TelegramChatsView> {
    const connection = this.status.current();
    const allowed = await this.allowedChats.list('telegram');
    const keys = new Set(allowed.map((chat) => chat.chatKey));
    return {
      bot: connection?.state === 'connected' ? connection.username : null,
      allowed: allowed.map((chat) => this.view(chat)),
      // A request stays in memory after its chat is allowed.
      pairing: this.pairing
        .recent('telegram')
        .filter((request) => !keys.has(request.chatKey))
        .map((request) => ({
          chatId: request.chatKey,
          kind: request.kind,
          title: request.title,
          firstSeenAt: request.firstSeenAt.toISOString(),
          lastSeenAt: request.lastSeenAt.toISOString(),
        })),
    };
  }

  /**
   * Allows chat `chatKey`. Its kind and name come from its pairing request,
   * otherwise from Telegram, otherwise from the ID alone: groups have
   * negative IDs. Waits briefly for the bot's standing in a group.
   */
  async allow(
    chatKey: string,
  ): Promise<{ chat: AllowedChatView; alreadyAllowed: boolean }> {
    const existing = await this.allowedChats.find('telegram', chatKey);
    const request = this.pairing
      .recent('telegram')
      .find((candidate) => candidate.chatKey === chatKey);
    const found =
      request ?? existing ?? (await this.adapter.lookUpChat(chatKey));
    const chat = await this.allowedChats.allow({
      integrationKind: 'telegram',
      chatKey,
      kind: found?.kind ?? (chatKey.startsWith('-') ? 'group' : 'private'),
      title: found?.title ?? existing?.title ?? null,
    });
    if (existing === null) {
      this.logger.log(`Allowed Telegram ${chat.kind} chat ${chatKey}`);
    }
    await this.countAllowed();
    await Promise.race([
      this.adapter.checkChat(chatKey).catch((error: unknown) => {
        this.logger.warn(
          `Failed to check Telegram chat ${chatKey}: ${String(error)}`,
        );
      }),
      new Promise((resolve) => setTimeout(resolve, CHECK_WAIT_MS).unref()),
    ]);
    return { chat: this.view(chat), alreadyAllowed: existing !== null };
  }

  /**
   * Removes chat `chatKey` from the allowlist. Its Channels, Agents, and
   * Sessions stay for when it is allowed again.
   */
  async deny(chatKey: string): Promise<{ chat: AllowedChatView }> {
    const denied = await this.allowedChats.deny('telegram', chatKey);
    if (denied === null) {
      throw new NotFoundError(`Telegram chat ${chatKey} is not allowed`);
    }
    const view = this.view(denied);
    this.logger.log(`Denied Telegram ${denied.kind} chat ${chatKey}`);
    this.status.forgetAccess(chatKey);
    await this.countAllowed();
    return { chat: view };
  }

  private async countAllowed(): Promise<void> {
    this.status.setAllowedChats(await this.allowedChats.count('telegram'));
  }

  private view(chat: AllowedChat): AllowedChatView {
    const access = this.status
      .access()
      .find((candidate) => candidate.chatKey === chat.chatKey);
    return {
      chatId: chat.chatKey,
      kind: chat.kind,
      title: access?.title ?? chat.title,
      bot: access?.status ?? null,
      topics: access?.topics ?? null,
      problem: access?.problem ?? null,
      allowedAt: chat.createdAt.toISOString(),
    };
  }
}
