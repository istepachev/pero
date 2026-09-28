import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { BackupService } from '../backup/backup.service.js';
import { parseInput } from '../common/errors.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import { withoutUndefined } from '../common/without-undefined.js';
import type { DataDirLayout } from '../config/data-dir.js';
import {
  type SettingsChange,
  settingsChangeSchema,
} from '../config/settings-input.js';
import { ComponentHealth } from '../health/component-health.js';
import { ProviderAuthService } from '../providers/provider-auth.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { TelegramChats } from '../telegram/telegram-chats.service.js';
import { TelegramCredentials } from '../telegram/telegram-credentials.service.js';
import { ControlServer } from './control-server.js';
import type { SettingsView, StatusResult } from './protocol.js';

export const CONTROL_LAYOUT = Symbol('CONTROL_LAYOUT');

export interface ControlStartOptions {
  /** Called once when a client asks the daemon to stop. */
  onShutdown: () => void;
}

/** The daemon side of the control endpoint and its operations. */
@Injectable()
export class ControlService implements OnModuleDestroy {
  private server: ControlServer | undefined;
  private readonly logger = new Logger('Control');
  private startedAt = new Date();
  private shutdownRequested = false;

  constructor(
    @Inject(CONTROL_LAYOUT) private readonly layout: DataDirLayout,
    private readonly health: ComponentHealth,
    private readonly settings: SettingsService,
    private readonly telegram: TelegramCredentials,
    private readonly telegramChats: TelegramChats,
    private readonly providers: ProviderAuthService,
    private readonly backup: BackupService,
  ) {}

  /**
   * Opens the control socket. Call it last during startup: a client that
   * gets an answer takes the daemon as ready.
   */
  async start(options: ControlStartOptions): Promise<void> {
    const server = new ControlServer({
      socketPath: this.layout.controlSocket,
      logger: this.logger,
      handlers: {
        status: () => this.status(),
        shutdown: () => {
          this.requestShutdown(options.onShutdown);
          return {};
        },
        'settings.get': () => this.settingsView(),
        'settings.update': (change) => this.updateSettings(change),
        'providers.check': async () => {
          await this.providers.check();
          return this.status();
        },
        'backup.create': ({ file }) => this.backup.create(file),
        'telegram.chats': () => this.telegramChats.list(),
        'telegram.allow': ({ chatId }) => this.telegramChats.allow(chatId),
        'telegram.deny': ({ chatId }) => this.telegramChats.deny(chatId),
      },
    });
    await server.listen();
    this.server = server;
    this.startedAt = new Date();
  }

  status(): StatusResult {
    return {
      pid: process.pid,
      version: PACKAGE_VERSION,
      dataDir: this.layout.root,
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - this.startedAt.getTime()),
      health: this.health.overall(),
      components: this.health.list(),
    };
  }

  async settingsView(): Promise<SettingsView> {
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      ...settings
    } = await this.settings.get();
    return {
      ...settings,
      telegramBotToken: {
        set: this.telegram.token() !== null,
        source: this.telegram.source(),
      },
    };
  }

  /**
   * Applies settings and the bot token together. Everything is validated
   * before anything is stored; only the names of changed fields are logged.
   */
  async updateSettings(change: SettingsChange): Promise<SettingsView> {
    const { telegramBotToken, ...update } = parseInput(
      settingsChangeSchema,
      change,
    );
    const fields = withoutUndefined(update);
    if (Object.keys(fields).length > 0) {
      await this.settings.update(fields);
      if (fields.defaultProvider !== undefined) {
        await this.providers.refreshRequirements();
      }
    }
    if (telegramBotToken !== undefined) this.telegram.set(telegramBotToken);

    const changed = Object.keys(
      withoutUndefined({ ...fields, telegramBotToken }),
    );
    this.logger.log(`Settings changed: ${changed.join(', ') || 'nothing'}`);
    return this.settingsView();
  }

  async onModuleDestroy(): Promise<void> {
    await this.server?.close();
    this.server = undefined;
  }

  // Deferred so the reply is on its way first; closing the server then
  // waits for it to finish.
  private requestShutdown(onShutdown: () => void): void {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    setImmediate(onShutdown);
  }
}
