import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EnvFilePermissionError, readEnvFile } from '../config/env-file.js';
import {
  TELEGRAM_TOKEN_ENV,
  telegramBotTokenSchema,
} from '../config/settings-input.js';
import { storeTelegramToken } from '../config/token-file.js';
import type { TokenSource } from '../control/protocol.js';
import { ComponentHealth } from '../health/component-health.js';
import { CONNECTING_DETAIL } from './telegram-status.js';

export const TELEGRAM_OPTIONS = Symbol('TELEGRAM_OPTIONS');

export interface TelegramOptions {
  /** The workspace's `.env`, which holds the token. */
  envFile: string;
  /** The workspace's `.gitignore`, made to list `.env` when it is written. */
  gitignore: string;
  /** The daemon's environment, which may carry the token. */
  env: NodeJS.ProcessEnv;
  /** The Bot API server; Telegram's own unless set. */
  apiRoot?: string;
}

/**
 * The Telegram bot token: from the environment when it is set there,
 * otherwise from the workspace's `.env`. Never logged and never sent to
 * the CLI. It
 * reports the Telegram component while there is no valid token; with one,
 * it reports connecting until the adapter says how the connection stands.
 */
@Injectable()
export class TelegramCredentials implements OnModuleInit {
  private readonly logger = new Logger('Telegram');
  private current: string | null = null;
  private currentSource: TokenSource | null = null;
  private readonly listeners = new Set<(token: string | null) => void>();

  constructor(
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
    private readonly health: ComponentHealth,
  ) {}

  onModuleInit(): void {
    this.resolve();
  }

  /** The token in use, or null when there is no valid one. */
  token(): string | null {
    return this.current;
  }

  /** Where the token comes from; null when neither place has one. */
  source(): TokenSource | null {
    return this.currentSource;
  }

  /**
   * Calls `listener` with the token in use each time it may have changed;
   * returns a function that stops the calls.
   */
  onChange(listener: (token: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Stores `token` in `.env` and takes it into use at once. A token in the
   * environment still wins over the stored one.
   */
  set(token: string): void {
    const value = telegramBotTokenSchema.parse(token);
    const { envFile, gitignore } = this.options;
    if (storeTelegramToken({ envFile, gitignore }, value)) {
      this.logger.log(`Added .env to ${gitignore}`);
    }
    this.logger.log('Bot token stored');
    this.resolve();
    for (const listener of this.listeners) listener(this.current);
  }

  private resolve(): void {
    const fromEnv = this.options.env[TELEGRAM_TOKEN_ENV]?.trim();
    if (fromEnv) {
      this.currentSource = 'environment';
      const parsed = telegramBotTokenSchema.safeParse(fromEnv);
      this.current = parsed.success ? parsed.data : null;
      if (parsed.success) {
        this.health.report('telegram', 'degraded', CONNECTING_DETAIL);
      } else {
        this.health.report(
          'telegram',
          'degraded',
          `${TELEGRAM_TOKEN_ENV} is not a valid bot token`,
        );
      }
      return;
    }

    let stored: string | null;
    try {
      stored = this.stored();
    } catch (error) {
      // Refused rather than read, as ssh refuses a key others can read.
      if (!(error instanceof EnvFilePermissionError)) throw error;
      this.currentSource = 'env-file';
      this.current = null;
      this.health.report('telegram', 'degraded', error.message);
      return;
    }
    const parsed = stored ? telegramBotTokenSchema.safeParse(stored) : null;
    this.currentSource = stored ? 'env-file' : null;
    this.current = parsed?.success ? parsed.data : null;
    if (!parsed) {
      this.health.report('telegram', 'unconfigured', 'Bot token is not set');
    } else if (parsed.success) {
      this.health.report('telegram', 'degraded', CONNECTING_DETAIL);
    } else {
      this.health.report(
        'telegram',
        'degraded',
        'The stored bot token is not valid; set it again',
      );
    }
  }

  /** The token stored in `.env`, trimmed; null when none is. */
  private stored(): string | null {
    const { envFile } = this.options;
    return readEnvFile(envFile)?.get(TELEGRAM_TOKEN_ENV)?.trim() || null;
  }
}
