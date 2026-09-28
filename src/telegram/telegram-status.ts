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

/** The bot's standing in one allowed group, as last checked. */
export interface ChatAccess {
  chatKey: string;
  title: string | null;
  /** The bot's membership; `unknown` when Telegram could not say. */
  status: 'administrator' | 'member' | 'left' | 'unknown';
  /** Why the bot cannot see every message there; null when it can. */
  problem: string | null;
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
          .map((chat) => chat.problem)
          .filter((problem) => problem !== null);
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
