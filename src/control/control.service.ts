import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AgentViews } from '../agents/agent-views.service.js';
import { BackupService } from '../backup/backup.service.js';
import { ChannelViews } from '../channels/channel-views.service.js';
import { parseInput } from '../common/errors.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import type { DataDirLayout } from '../config/data-dir.js';
import {
  type SettingsChange,
  settingsChangeSchema,
} from '../config/settings-input.js';
import { Definitions } from '../definitions/definitions.js';
import { ComponentHealth } from '../health/component-health.js';
import { NotificationDelivery } from '../notifications/notification-delivery.js';
import { NotificationViews } from '../notifications/notification-views.service.js';
import { ProviderAuthService } from '../providers/provider-auth.service.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { WorkspaceChecks } from '../settings-notes/workspace-checks.service.js';
import { PERO_NOTE } from '../settings-files/note-files.js';
import { shownPath } from '../settings-files/note-hints.js';
import { TelegramChats } from '../telegram/telegram-chats.service.js';
import { TelegramCredentials } from '../telegram/telegram-credentials.service.js';
import { WorkflowRuns } from '../workflows/workflow-runs.service.js';
import { WorkflowViews } from '../workflows/workflow-views.service.js';
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
    private readonly telegram: TelegramCredentials,
    private readonly telegramChats: TelegramChats,
    private readonly providers: ProviderAuthService,
    private readonly backup: BackupService,
    private readonly agentViews: AgentViews,
    private readonly channelViews: ChannelViews,
    private readonly workflowViews: WorkflowViews,
    private readonly workflowRuns: WorkflowRuns,
    private readonly delivery: NotificationDelivery,
    private readonly notificationViews: NotificationViews,
    private readonly workspaceChecks: WorkspaceChecks,
    private readonly definitions: Definitions,
    private readonly notes: SettingsNotes,
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
        check: () => this.workspaceChecks.check(),
        'settings.get': () => this.settingsView(),
        'settings.update': (change) => this.updateSettings(change),
        'providers.check': async () => {
          await this.providers.check();
          return this.status();
        },
        'agents.list': async () => ({ agents: await this.agentViews.list() }),
        'agents.get': ({ name }) => this.agentViews.details(name),
        'channels.list': async () => ({
          channels: await this.channelViews.list(),
        }),
        'channels.get': ({ id }) => this.channelViews.details(id),
        'channels.history': ({ id, limit }) =>
          this.channelViews.history(id, limit),
        'workflows.list': async () => ({
          workflows: await this.workflowViews.list(),
        }),
        'workflows.get': ({ name }) => this.workflowViews.details(name),
        'workflows.run': ({ name }) => this.workflowRuns.start(name),
        'runs.list': async (filter) => ({
          runs: await this.workflowRuns.list(filter),
        }),
        'runs.get': ({ id }) => this.workflowRuns.get(id),
        'runs.retry': ({ id }) => this.workflowRuns.retry(id),
        'runs.cancel': ({ id }) => this.workflowRuns.cancel(id),
        'notifications.list': async (filter) => ({
          notifications: await this.notificationViews.list(filter),
        }),
        'notifications.get': ({ id }) => this.notificationViews.details(id),
        'notifications.retry': async ({ id }) => {
          await this.delivery.retry(id);
          return this.notificationViews.details(id);
        },
        'backup.create': ({ file, includeData }) =>
          this.backup.create(file, { includeData }),
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
      workspace: this.layout.workspace,
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - this.startedAt.getTime()),
      health: this.health.overall(),
      components: this.health.list(),
    };
  }

  /**
   * The settings in effect: a workspace's `Pero.md` and `config.yaml`, or
   * the defaults a legacy data directory kept, which can't be changed.
   */
  async settingsView(): Promise<SettingsView> {
    const defaults = await this.definitions.defaults();
    const snapshot = await this.notes.ready();
    const folders = this.notes.folders();
    return {
      defaultProvider: defaults.provider,
      providerDefaults: defaults.providerDefaults,
      defaultWorkingDirectory: defaults.dataFolder,
      sharedInstructions: defaults.sharedInstructions,
      mainAgent: await this.definitions.mainAgentName(),
      historyCarryover: defaults.historyCarryover,
      historyRetentionDays: defaults.historyRetentionDays,
      defaultPermissions: defaults.permissions,
      timezone: defaults.timezone,
      maxConcurrentRuns: defaults.maxConcurrentRuns,
      telegramBotToken: {
        set: this.telegram.token() !== null,
        source: this.telegram.source(),
      },
      files:
        folders === null
          ? null
          : {
              pero: shownPath(
                folders.workspace,
                join(folders.settingsFolder, PERO_NOTE),
              ),
              config: shownPath(folders.workspace, this.layout.configFile),
            },
      newTopics: snapshot?.defaults.newTopics ?? null,
      setInPero: snapshot === null ? null : [...snapshot.peroProperties].sort(),
    };
  }

  /**
   * Sets or removes the stored bot token, the one setting Pero changes
   * itself; notes and `config.yaml` hold the others.
   */
  async updateSettings(change: SettingsChange): Promise<SettingsView> {
    const { telegramBotToken } = parseInput(settingsChangeSchema, change);
    if (telegramBotToken !== undefined) {
      this.telegram.set(telegramBotToken);
      this.logger.log('Settings changed: telegramBotToken');
    }
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
