import { Injectable } from '@nestjs/common';
import { chatKindOf } from '../config/host-config.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import type { ChatKind, IntegrationKind } from '../persistence/entities/sql.js';

/** A chat Pero serves; messages from any other chat never reach a Channel. */
export interface AllowedChatEntry {
  integrationKind: IntegrationKind;
  /** The integration's chat ID, as a string; Telegram's may exceed 2^53. */
  chatKey: string;
  kind: ChatKind;
  /** The chat's name as last seen, else its label in `config.yaml`. */
  title: string | null;
}

export interface ChatToAllow {
  integrationKind: IntegrationKind;
  chatKey: string;
  kind: ChatKind;
  title: string | null;
}

/**
 * The chats Pero serves: `telegram.allowed-chats` in `config.yaml`. Only
 * the owner on the host adds to them, through the file or the CLI. Chat
 * names seen in messages are kept in memory only, so Pero writes the file
 * just when the list itself changes.
 */
@Injectable()
export class AllowedChatsService {
  private readonly seenTitles = new Map<string, string>();

  constructor(private readonly hostConfig: HostConfigService) {}

  find(
    integrationKind: IntegrationKind,
    chatKey: string,
  ): Promise<AllowedChatEntry | null> {
    const found = this.entries(integrationKind).find(
      (chat) => chat.chatKey === chatKey,
    );
    return Promise.resolve(found ?? null);
  }

  /** The integration's allowed chats, in the file's order. */
  list(integrationKind: IntegrationKind): Promise<AllowedChatEntry[]> {
    return Promise.resolve(this.entries(integrationKind));
  }

  /**
   * Allows a chat, labelled with its title in `config.yaml`. Allowing one
   * again keeps its entry.
   */
  async allow(chat: ChatToAllow): Promise<AllowedChatEntry> {
    this.hostConfig.allow(chat.chatKey, chat.title);
    if (chat.title !== null) this.seenTitles.set(chat.chatKey, chat.title);
    return (await this.find(chat.integrationKind, chat.chatKey))!;
  }

  /**
   * Removes a chat from the allowlist and returns what it was; null when it
   * was not allowed. Its Channels, Agents, Sessions, and history stay, so
   * allowing it again picks up where it left off.
   */
  async deny(
    integrationKind: IntegrationKind,
    chatKey: string,
  ): Promise<AllowedChatEntry | null> {
    const existing = await this.find(integrationKind, chatKey);
    if (existing !== null) this.hostConfig.deny(chatKey);
    return existing;
  }

  /**
   * Follows an allowed chat to its new ID, as when a group turns on topics;
   * false when it was not allowed.
   */
  migrate(integrationKind: IntegrationKind, from: string, to: string): boolean {
    if (integrationKind !== 'telegram') return false;
    const title = this.seenTitles.get(from);
    if (title !== undefined) this.seenTitles.set(to, title);
    return this.hostConfig.moveChat(from, to);
  }

  /** How many chats the integration serves. */
  async count(integrationKind: IntegrationKind): Promise<number> {
    return (await this.list(integrationKind)).length;
  }

  /** Remembers the chat's current name; nothing is written. */
  refreshTitle(chat: AllowedChatEntry, title: string | null): Promise<void> {
    if (title !== null) this.seenTitles.set(chat.chatKey, title);
    return Promise.resolve();
  }

  private entries(integrationKind: IntegrationKind): AllowedChatEntry[] {
    if (integrationKind !== 'telegram') return [];
    return this.hostConfig.allowedChats().map((chat) => ({
      integrationKind,
      chatKey: chat.chatKey,
      kind: chatKindOf(chat.chatKey),
      title: this.seenTitles.get(chat.chatKey) ?? chat.title,
    }));
  }
}
