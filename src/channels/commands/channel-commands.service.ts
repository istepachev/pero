import { relative } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AgentManager } from '../../agents/agent-manager.js';
import { AgentViews } from '../../agents/agent-views.service.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../../common/errors.js';
import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  type Provider,
} from '../../config/provider-options.js';
import type { AgentView } from '../../control/protocol.js';
import { ComponentHealth } from '../../health/component-health.js';
import { MessageHistory } from '../../history/message-history.service.js';
import { Channel } from '../../persistence/entities/channel.entity.js';
import { Message } from '../../persistence/entities/message.entity.js';
import { Session } from '../../persistence/entities/session.entity.js';
import { inTransaction } from '../../persistence/transaction.js';
import { SessionService } from '../../sessions/session.service.js';
import { AgentNotes } from '../../settings/agent-notes.service.js';
import { Definitions, type Route } from '../../settings/definitions.js';
import { SettingsNotes } from '../../settings/settings-notes.service.js';
import type {
  ActionResult,
  InboundAction,
  InboundCommand,
} from '../channel-adapter.js';
import { ChannelSender } from '../channel-sender.js';
import { unansweredText } from '../channel-stages.js';
import { buttonCommand } from './command-list.js';
import { WorkflowCommands } from './workflow-commands.js';
import {
  type AgentOption,
  type AgentStatus,
  type Answer,
  helpScreen,
  optionScreen,
  optionSetScreen,
  type OptionStatus,
  newConfirmScreen,
  newDoneScreen,
  noAgentScreen,
  type Screen,
  statusScreen,
  stopScreen,
} from './screens.js';

/**
 * Well-known model names each provider's CLI accepts, offered first; the
 * owner types any other.
 */
const MODEL_SUGGESTIONS: Record<Provider, readonly string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.5'],
};

/** How many models `/model` offers as buttons. */
const MAX_MODEL_CHOICES = 9;

/**
 * Answers the commands Pero handles itself, such as `/status` and `/new`,
 * in the Channel they were sent in. A typed command gets a new message; a
 * pressed button edits the message it belongs to, so menus nest in place.
 * Neither joins the Channel's history.
 */
@Injectable()
export class ChannelCommands {
  private readonly logger = new Logger('Channels');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sender: ChannelSender,
    private readonly agents: AgentManager,
    private readonly agentViews: AgentViews,
    private readonly sessions: SessionService,
    private readonly history: MessageHistory,
    private readonly health: ComponentHealth,
    private readonly definitions: Definitions,
    private readonly notes: SettingsNotes,
    private readonly agentNotes: AgentNotes,
    private readonly workflows: WorkflowCommands,
  ) {}

  /** Answers `command`, typed in `channel`, which `route` answers now. */
  async run(
    channel: Channel,
    route: Route,
    command: InboundCommand,
  ): Promise<void> {
    const { screen } = await this.answer(channel, route, command, null);
    try {
      await this.sender.send(channel.integrationKind, channel.address, screen);
    } catch (error) {
      this.logger.warn(
        `Failed to answer /${command.name} in ${where(channel)}: ${describe(error)}`,
      );
    }
  }

  /** Answers a press of one of the commands' buttons, editing its message. */
  async press(
    channel: Channel,
    route: Route,
    action: InboundAction,
  ): Promise<ActionResult> {
    const command = buttonCommand(action.actionId);
    if (command === null) return { notice: 'This button no longer works' };
    const by = action.senderName ?? `user ${action.senderId}`;
    const { screen, notice } = await this.answer(channel, route, command, by);
    try {
      await this.sender.edit(
        channel.integrationKind,
        channel.address,
        action.messageId,
        screen,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to answer a /${command.name} button in ${where(channel)}: ${describe(error)}`,
      );
    }
    return { notice };
  }

  /** `command`'s answer; `by` names who pressed its button, if one did. */
  private async answer(
    channel: Channel,
    route: Route,
    command: InboundCommand,
    by: string | null,
  ): Promise<Answer> {
    try {
      switch (command.name) {
        case 'help':
          return { screen: helpScreen(), notice: null };
        case 'status':
          return { screen: await this.status(channel, route), notice: null };
        case 'new':
          return await this.startOver(channel, route, command.args, by);
        case 'stop':
          return this.stop(channel, route, by);
        case 'workflows':
          return await this.workflows.workflows(command.args.trim());
        case 'run':
          return await this.workflows.run(command.args.trim(), by);
        case 'runs':
          return await this.workflows.runs(command.args.trim());
        case 'cancel':
          return await this.workflows.cancel(command.args.trim(), by);
        case 'retry':
          return await this.workflows.retry(command.args.trim(), by);
        case 'model':
        case 'effort':
          return await this.option(
            route,
            command.name,
            command.args.trim(),
            by,
          );
        default:
          return {
            screen: {
              text: `Pero has no /${command.name}; /help lists its commands.`,
            },
            notice: null,
          };
      }
    } catch (error) {
      if (
        error instanceof InvalidInputError ||
        error instanceof NotFoundError ||
        error instanceof ConflictError
      ) {
        return { screen: { text: error.message }, notice: null };
      }
      this.logger.error(
        `Failed to run /${command.name} in ${where(channel)}: ${describe(error)}`,
      );
      return {
        screen: { text: `Pero couldn't run /${command.name}; see pero logs` },
        notice: null,
      };
    }
  }

  private async status(channel: Channel, route: Route): Promise<Screen> {
    const { timezone } = this.definitions.defaults();
    return statusScreen({
      where: channel.title,
      agent:
        route.kind === 'agent'
          ? await this.agentStatus(channel, route.agent.name)
          : null,
      unanswered: route.kind === 'agent' ? null : unansweredText(route.reason),
      components: this.health.list(),
      timezone,
      now: new Date(),
    });
  }

  private async agentStatus(
    channel: Channel,
    name: string,
  ): Promise<AgentStatus> {
    const agent = await this.agentViews.details(name);
    const activity = this.agents.activity(channel.id);
    const { workspace } = this.notes.folders();
    return inTransaction(this.dataSource, async (manager) => {
      const session = await manager.getRepository(Session).findOneBy({
        channelId: channel.id,
        agentName: name,
        status: 'active',
      });
      const messages = manager.getRepository(Message);
      const lastAnswer = await messages.findOne({
        select: { id: true, createdAt: true },
        where: { channelId: channel.id, origin: 'agent' },
        order: { id: 'DESC' },
      });
      return {
        agent,
        folder: shownFolder(workspace, agent.effectiveWorkingDirectory),
        folderProblem: agent.folderProblem,
        runningSince: activity.runningSince,
        queued: activity.queued,
        lastAnswerAt: lastAnswer?.createdAt ?? null,
        session:
          session === null
            ? null
            : {
                id: session.id,
                createdAt: session.createdAt,
                turns: await messages.countBy({
                  sessionId: session.id,
                  origin: 'user',
                }),
                contextTokens: session.contextTokens,
                contextWindow: session.contextWindow,
              },
        startedOver: channel.contextFromMessageId !== null,
      };
    });
  }

  /**
   * `/new`: stops the Agent, closes the Channel's Session, and marks where
   * the next one starts, so it carries nothing from before. Its button
   * asks first (`ask`); typed, or confirmed (`yes`), it acts at once.
   */
  private async startOver(
    channel: Channel,
    route: Route,
    args: string,
    by: string | null,
  ): Promise<Answer> {
    if (route.kind !== 'agent') {
      return {
        screen: noAgentScreen(unansweredText(route.reason)),
        notice: null,
      };
    }
    const agent = route.agent.name;
    if (args === 'ask') {
      return { screen: newConfirmScreen(agent), notice: null };
    }
    // Stopped first: an answer still coming would join the new context.
    const { stopped } = this.agents.stop(channel.id);
    await inTransaction(this.dataSource, async (manager) => {
      await this.sessions.closeChannelWithin(manager, channel.id);
      await manager.getRepository(Channel).update(channel.id, {
        contextFromMessageId: await this.history.latestIdWithin(manager),
      });
    });
    this.logger.log(`Started ${where(channel)} over, as ${by ?? 'asked'}`);
    return {
      screen: newDoneScreen(agent, stopped, by),
      notice: 'Started over',
    };
  }

  /**
   * `/model` and `/effort`: without a value, the Agent's current one and a
   * button for each choice; with one, or `default`, it goes into the
   * Agent's note, from where it applies to the Agent's next answer.
   */
  private async option(
    route: Route,
    option: AgentOption,
    value: string,
    by: string | null,
  ): Promise<Answer> {
    if (route.kind !== 'agent') {
      return {
        screen: noAgentScreen(unansweredText(route.reason)),
        notice: null,
      };
    }
    const name = route.agent.name;
    const status = this.optionStatus(
      await this.agentViews.details(name),
      option,
    );
    if (value === '') return { screen: optionScreen(status), notice: null };
    const wanted =
      value.toLowerCase() === 'default'
        ? null
        : option === 'effort'
          ? value.toLowerCase()
          : value;
    const problem =
      wanted === null
        ? null
        : option === 'effort' && !status.choices.includes(wanted)
          ? `There is no effort ${value} for ${route.agent.provider}.`
          : /\s/.test(wanted)
            ? `A model's name has no spaces: ${value}`
            : null;
    if (problem !== null) {
      return { screen: optionScreen(status, problem), notice: null };
    }
    const { changed } = await this.agentNotes.setProperty(name, option, wanted);
    const after = this.optionStatus(
      await this.agentViews.details(name),
      option,
    );
    return {
      screen: optionSetScreen(after, changed, by),
      notice: changed ? `${option === 'model' ? 'Model' : 'Effort'} set` : null,
    };
  }

  /** What `/model` or `/effort` shows of `agent`, with its choices. */
  private optionStatus(agent: AgentView, option: AgentOption): OptionStatus {
    const defaults =
      this.definitions.defaults().providerDefaults[agent.provider];
    const value = agent[option];
    return {
      agent: agent.name,
      file: agent.file,
      option,
      value,
      origin: agent.origins[option],
      peroDefault: defaults[option],
      choices:
        option === 'effort'
          ? agent.provider === 'claude'
            ? CLAUDE_EFFORTS
            : CODEX_EFFORTS
          : this.modelChoices(agent.provider, [value, defaults.model]),
    };
  }

  /**
   * Models to offer for `provider`: its well-known names, then those the
   * workspace already uses, such as other Agents' and `Pero.md`'s.
   */
  private modelChoices(
    provider: Provider,
    used: readonly (string | null)[],
  ): string[] {
    const others = this.definitions
      .agents()
      .filter((agent) => agent.provider === provider)
      .map((agent) => agent.model);
    const choices = new Set<string>(MODEL_SUGGESTIONS[provider]);
    for (const model of [...used, ...others]) {
      if (model !== null) choices.add(model);
    }
    return [...choices].slice(0, MAX_MODEL_CHOICES);
  }

  /** `/stop`: stops the running answer and drops the waiting messages. */
  private stop(channel: Channel, route: Route, by: string | null): Answer {
    const result = this.agents.stop(channel.id);
    const agent = route.kind === 'agent' ? route.agent.name : null;
    if (result.stopped || result.dropped > 0) {
      this.logger.log(
        `Stopped ${where(channel)}: ${result.stopped ? 'its running turn and ' : ''}${result.dropped} waiting`,
      );
    }
    return {
      screen: stopScreen(agent, result, by),
      notice:
        result.stopped || result.dropped > 0 ? 'Stopped' : 'Nothing to stop',
    };
  }
}

/** The folder an Agent works in, as its owner names it. */
function shownFolder(workspace: string, folder: string): string {
  const inside = relative(workspace, folder);
  if (inside === '') return 'the workspace';
  return inside.startsWith('..') ? folder : inside;
}

function where(channel: Pick<Channel, 'id' | 'integrationKind'>): string {
  return `${channel.integrationKind} Channel ${channel.id}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
