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
import { PACKAGE_VERSION } from '../common/package-version.js';
import type { WorkspaceLayout } from '../config/workspace-layout.js';
import { ComponentHealth } from '../health/component-health.js';
import { NotificationDelivery } from '../notifications/notification-delivery.js';
import { NotificationViews } from '../notifications/notification-views.service.js';
import { ProviderAuthService } from '../providers/provider-auth.service.js';
import { PERO_NOTE } from '../settings-files/note-files.js';
import { shownPath } from '../settings-files/note-paths.js';
import { Definitions } from '../settings/definitions.js';
import { SettingsNotes } from '../settings/settings-notes.service.js';
import { WorkspaceChecks } from '../settings/workspace-checks.service.js';
import { TelegramChats } from '../telegram/telegram-chats.service.js';
import { TelegramCredentials } from '../telegram/telegram-credentials.service.js';
import { WorkflowRuns } from '../workflows/workflow-runs.service.js';
import { WorkflowViews } from '../workflows/workflow-views.service.js';
import { ControlServer } from './control-server.js';
import type { SettingsView, StatusResult, TokenView } from './protocol.js';

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
    @Inject(CONTROL_LAYOUT) private readonly layout: WorkspaceLayout,
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
        'telegram.token': ({ token }) => {
          this.telegram.set(token);
          return this.tokenView();
        },
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
      workspace: this.layout.workspace,
      stateDir: this.layout.stateDir,
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - this.startedAt.getTime()),
      health: this.health.overall(),
      components: this.health.list(),
    };
  }

  /** The settings in effect: the workspace's `Pero.md` and `config.yaml`. */
  async settingsView(): Promise<SettingsView> {
    const defaults = this.definitions.defaults();
    const snapshot = this.notes.snapshot();
    const folders = this.notes.folders();
    return {
      defaultProvider: defaults.provider,
      providerDefaults: defaults.providerDefaults,
      dataFolder: defaults.dataFolder,
      mainAgent: this.definitions.mainAgentName(),
      historyCarryover: defaults.historyCarryover,
      historyRetentionDays: defaults.historyRetentionDays,
      defaultPermissions: defaults.permissions,
      timezone: defaults.timezone,
      maxConcurrentRuns: defaults.maxConcurrentRuns,
      telegramBotToken: this.tokenView(),
      files: {
        pero: shownPath(
          folders.workspace,
          join(folders.settingsFolder, PERO_NOTE),
        ),
        config: shownPath(folders.workspace, this.layout.configFile),
      },
      setInPero: snapshot === null ? null : [...snapshot.peroProperties].sort(),
    };
  }

  private tokenView(): TokenView {
    return {
      set: this.telegram.token() !== null,
      source: this.telegram.source(),
    };
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
