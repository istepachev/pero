import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AgentViews } from '../agents/agent-views.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { BackupService } from '../backup/backup.service.js';
import { ChannelViews } from '../channels/channel-views.service.js';
import { ChannelsService } from '../channels/channels.service.js';
import { parseInput } from '../common/errors.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import { withoutUndefined } from '../common/without-undefined.js';
import type { AgentCreate, AgentEdit } from '../config/agent-input.js';
import type {
  TriggerAdd,
  WorkflowCreate,
  WorkflowEdit,
} from '../config/workflow-input.js';
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
import { TriggersService } from '../triggers/triggers.service.js';
import { WorkflowRuns } from '../workflows/workflow-runs.service.js';
import { WorkflowViews } from '../workflows/workflow-views.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { ControlServer } from './control-server.js';
import type {
  AgentDetails,
  ChannelDetails,
  ControlResult,
  SettingsView,
  StatusResult,
  TriggerView,
  WorkflowDetails,
} from './protocol.js';

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
    private readonly agents: AgentsService,
    private readonly agentViews: AgentViews,
    private readonly channels: ChannelsService,
    private readonly channelViews: ChannelViews,
    private readonly workflows: WorkflowsService,
    private readonly workflowViews: WorkflowViews,
    private readonly workflowRuns: WorkflowRuns,
    private readonly triggers: TriggersService,
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
        'agents.list': async () => ({ agents: await this.agentViews.list() }),
        'agents.get': ({ name }) => this.agentViews.details(name),
        'agents.create': (input) => this.createAgent(input),
        'agents.edit': ({ name, change }) => this.editAgent(name, change),
        'channels.list': async () => ({
          channels: await this.channelViews.list(),
        }),
        'channels.get': ({ id }) => this.channelViews.details(id),
        'channels.assign': ({ id, agent }) => this.assignChannel(id, agent),
        'channels.setEnabled': ({ id, enabled }) =>
          this.setChannelEnabled(id, enabled),
        'channels.history': ({ id, limit }) =>
          this.channelViews.history(id, limit),
        'workflows.list': async () => ({
          workflows: await this.workflowViews.list(),
        }),
        'workflows.get': ({ name }) => this.workflowViews.details(name),
        'workflows.create': (input) => this.createWorkflow(input),
        'workflows.edit': ({ name, change }) => this.editWorkflow(name, change),
        'workflows.run': ({ name }) => this.workflowRuns.start(name),
        'runs.get': ({ id }) => this.workflowRuns.get(id),
        'runs.cancel': ({ id }) => this.workflowRuns.cancel(id),
        'triggers.list': async ({ workflow }) => ({
          triggers: await this.triggers.list(workflow),
        }),
        'triggers.add': (input) => this.addTrigger(input),
        'triggers.remove': ({ id }) => this.removeTrigger(id),
        'triggers.setEnabled': ({ id, enabled }) =>
          this.setTriggerEnabled(id, enabled),
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
      mainAgentId,
      mainAgent: _m,
      ...settings
    } = await this.settings.get();
    return {
      ...settings,
      mainAgent: await this.settings.mainAgentName({ mainAgentId }),
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

  async createAgent(input: AgentCreate): Promise<AgentDetails> {
    const agent = await this.agents.create(input);
    await this.providers.refreshRequirements();
    this.logger.log(`Agent ${agent.name} created`);
    return this.agentViews.details(agent.name);
  }

  /**
   * Changes an Agent. Its provider and whether it is enabled decide which
   * providers health depends on. Only the names of changed fields are
   * logged.
   */
  async editAgent(name: string, change: AgentEdit): Promise<AgentDetails> {
    const agent = await this.agents.edit(name, change);
    await this.providers.refreshRequirements();
    const changed = Object.keys(withoutUndefined(change));
    this.logger.log(
      `Agent ${agent.name} changed: ${changed.join(', ') || 'nothing'}`,
    );
    return this.agentViews.details(agent.name);
  }

  async assignChannel(
    id: number,
    agent: string,
  ): Promise<ControlResult<'channels.assign'>> {
    const { from, to, alreadyAssigned } = await this.channels.assign(id, agent);
    if (!alreadyAssigned) {
      this.logger.log(`Channel ${id} reassigned from Agent ${from} to ${to}`);
    }
    return { channel: await this.channelViews.details(id), alreadyAssigned };
  }

  async setChannelEnabled(
    id: number,
    enabled: boolean,
  ): Promise<ChannelDetails> {
    await this.channels.setEnabled(id, enabled);
    this.logger.log(`Channel ${id} ${enabled ? 'enabled' : 'disabled'}`);
    return this.channelViews.details(id);
  }

  async createWorkflow(input: WorkflowCreate): Promise<WorkflowDetails> {
    const workflow = await this.workflows.create(input);
    this.logger.log(`Workflow ${workflow.name} created`);
    return this.workflowViews.details(workflow.name);
  }

  /** Changes a Workflow; only the names of changed fields are logged. */
  async editWorkflow(
    name: string,
    change: WorkflowEdit,
  ): Promise<WorkflowDetails> {
    const workflow = await this.workflows.edit(name, change);
    const changed = Object.keys(withoutUndefined(change));
    this.logger.log(
      `Workflow ${workflow.name} changed: ${changed.join(', ') || 'nothing'}`,
    );
    return this.workflowViews.details(workflow.name);
  }

  async addTrigger(input: TriggerAdd): Promise<TriggerView> {
    const trigger = await this.triggers.add(input);
    this.logger.log(
      `Trigger ${trigger.id} (${trigger.kind}) added to Workflow ${trigger.workflow}`,
    );
    return trigger;
  }

  async removeTrigger(id: number): Promise<TriggerView> {
    const trigger = await this.triggers.remove(id);
    this.logger.log(`Trigger ${id} removed from Workflow ${trigger.workflow}`);
    return trigger;
  }

  async setTriggerEnabled(id: number, enabled: boolean): Promise<TriggerView> {
    const trigger = await this.triggers.setEnabled(id, enabled);
    this.logger.log(`Trigger ${id} ${enabled ? 'enabled' : 'disabled'}`);
    return trigger;
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
