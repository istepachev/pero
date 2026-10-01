import { Injectable } from '@nestjs/common';
import { ComponentHealth } from '../health/component-health.js';

/** The Telegram component's detail from a valid token until connected. */
export const CONNECTING_DETAIL = 'Connecting to Telegram';

/** How the connection to the Bot API stands while there is a valid token. */
export type TelegramConnection =
  | { state: 'connecting' }
  | { state: 'connected'; username: string }
  | { state: 'rejected' }
  | { state: 'conflict' }
  | { state: 'unreachable'; reason: string };

/** The problem Telegram reports while it serves no chat at all. */
export const NO_CHAT_ALLOWED =
  'no chat is allowed yet: add the bot to a group or message it, then ' +
  'pero telegram allow <chat-id>';

/** The bot's standing in one allowed group, as last checked. */
export interface ChatAccess {
  chatKey: string;
  title: string | null;
  /** The bot's membership; `unknown` when Telegram could not say. */
  status: 'administrator' | 'member' | 'left' | 'unknown';
  /** Whether the group has topics; null when Telegram could not say. */
  topics: boolean | null;
  /** The group's public username; null when it is private. */
  username: string | null;
  /** Why the bot cannot see every message there; null when it can. */
  problem: string | null;
  /** Why the group is unsafe to serve, as a public one is; null when not. */
  danger: string | null;
  checkedAt: Date;
}

/**
 * The Telegram component's state: the connection, and whether the bot can
 * see every message in each allowed group. The adapter updates it; while
 * there is no valid token, `TelegramCredentials` reports instead.
 */
@Injectable()
export class TelegramStatus {
  private connection: TelegramConnection | null = null;
  private readonly chats = new Map<string, ChatAccess>();
  /** How many chats are allowed; null until the adapter has counted. */
  private allowedChats: number | null = null;

  constructor(private readonly health: ComponentHealth) {}

  /** The connection's state; null while there is no valid token. */
  current(): TelegramConnection | null {
    return this.connection;
  }

  setConnection(connection: TelegramConnection | null): void {
    this.connection = connection;
    if (connection === null) this.chats.clear();
    this.report();
  }

  /** Each allowed group's last check, by chat key. */
  access(): ChatAccess[] {
    return [...this.chats.values()];
  }

  setAccess(access: ChatAccess): void {
    this.chats.set(access.chatKey, access);
    this.report();
  }

  forgetAccess(chatKey: string): void {
    if (this.chats.delete(chatKey)) this.report();
  }

  /** Notes that group `chatKey` has topics, as a topic created there shows. */
  markTopics(chatKey: string): void {
    const access = this.chats.get(chatKey);
    if (access === undefined || access.topics === true) return;
    this.chats.set(chatKey, { ...access, topics: true });
  }

  /** Records how many chats are allowed; none leaves Telegram degraded. */
  setAllowedChats(count: number): void {
    this.allowedChats = count;
    this.report();
  }

  private report(): void {
    const connection = this.connection;
    if (connection === null) return;
    switch (connection.state) {
      case 'connecting':
        this.health.report('telegram', 'degraded', CONNECTING_DETAIL);
        return;
      case 'rejected':
        // The owner has to set another token, as when none is set.
        this.health.report(
          'telegram',
          'unconfigured',
          'Telegram rejected the bot token',
        );
        return;
      case 'conflict':
        this.health.report(
          'telegram',
          'degraded',
          "Another process is receiving this bot's updates; stop it or give Pero its own bot",
        );
        return;
      case 'unreachable':
        this.health.report(
          'telegram',
          'degraded',
          `Can't reach Telegram: ${connection.reason}`,
        );
        return;
      case 'connected': {
        const connected = `Connected as @${connection.username}`;
        const problems = [...this.chats.values()]
          .flatMap((chat) => [chat.danger, chat.problem])
          .filter((problem) => problem !== null);
        if (this.allowedChats === 0) problems.unshift(NO_CHAT_ALLOWED);
        if (problems.length === 0) {
          this.health.report('telegram', 'ok', connected);
        } else {
          this.health.report(
            'telegram',
            'degraded',
            [connected, ...problems].join('; '),
          );
        }
      }
    }
  }
}
