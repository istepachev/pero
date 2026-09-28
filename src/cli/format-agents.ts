import type {
  AgentChannelView,
  AgentDetails,
  AgentView,
  NextTurn,
} from '../control/protocol.js';
import { table } from './format-status.js';
import { preview } from './settings-keys.js';

const DEFAULT = 'default';

/** `pero agents ls`: one row per Agent, the main one marked. */
export function formatAgentList(agents: readonly AgentView[]): string {
  if (agents.length === 0) {
    return (
      'No Agents yet. Create a topic in an allowed Telegram group, ' +
      'or run pero agents create <name>.'
    );
  }
  const lines = table([
    ['NAME', 'PROVIDER', 'MODEL', 'EFFORT', 'FOLDER', 'PERMISSIONS', 'STATE'],
    ...agents.map((agent) => [
      agent.main ? `${agent.name} *` : agent.name,
      agent.provider,
      agent.model ?? DEFAULT,
      agent.effort ?? DEFAULT,
      folder(agent),
      agent.permissions,
      agent.enabled ? 'enabled' : 'disabled',
    ]),
  ]);
  if (agents.some((agent) => agent.main)) {
    lines.push('', '* the main Agent: General topics and direct chats');
  }
  return lines.join('\n');
}

/** `pero agents show`: settings, then each Channel's next turn. */
export function formatAgentDetails(agent: AgentDetails): string {
  const lines = [
    `Agent ${agent.name}${agent.title === null ? '' : ` "${agent.title}"`}`,
    ...table([
      ['provider', agent.provider],
      ['model', agent.model ?? '(provider default)'],
      ['effort', agent.effort ?? '(provider default)'],
      ['working directory', folder(agent)],
      ['instructions', preview(agent.instructions)],
      ['shared instructions', agent.useSharedInstructions ? 'on' : 'off'],
      ['permissions', agent.permissions],
      ['codex git check', agent.codexSkipGitRepoCheck ? 'skipped' : 'required'],
      ['state', agent.enabled ? 'enabled' : 'disabled'],
      [
        'main agent',
        agent.main ? 'yes: General topics and direct chats' : 'no',
      ],
    ]).map((row) => `  ${row}`),
  ];
  if (agent.folderProblem !== null) {
    lines.push('', `Warning: ${agent.folderProblem}`);
  }
  lines.push('');
  if (agent.channels.length === 0) {
    lines.push('No Channel is assigned to it yet.');
  } else {
    lines.push(
      'Channels',
      ...table([
        ['ID', 'CHANNEL', 'TITLE', 'NEXT TURN'],
        ...agent.channels.map((channel) => [
          String(channel.id),
          `${channel.integrationKind} ${channel.key}`,
          title(channel),
          describeNextTurn(channel.nextTurn),
        ]),
      ]).map((row) => `  ${row}`),
    );
  }
  return lines.join('\n');
}

/** What the next turn in a Channel does with its Session. */
export function describeNextTurn(turn: NextTurn): string {
  const carried = turn.carriesOver
    ? ", with the Channel's recent messages"
    : '';
  switch (turn.kind) {
    case 'new':
      return `starts its first Session${carried}`;
    case 'resume':
      return `resumes Session ${turn.sessionId}`;
    case 'restart':
      return `starts Session ${turn.sessionId} over${carried}`;
    case 'fresh':
      return `fresh Session: ${turn.reason} was ${turn.from}${carried}`;
  }
}

/** One line on an Agent: what runs it and where. */
export function summarize(agent: AgentView): string {
  const model = agent.model === null ? 'default model' : agent.model;
  const effort =
    agent.effort === null ? 'default effort' : `${agent.effort} effort`;
  return `${agent.provider}, ${model}, ${effort}, working in ${folder(agent)}`;
}

/**
 * What an edit means for the Agent's Sessions: which Channels start a
 * fresh one, or that model and effort apply within the same Session.
 */
export function sessionEffect(
  agent: AgentDetails,
  changedWithinSession: boolean,
): string | null {
  const fresh = agent.channels.filter(
    (channel) => channel.nextTurn.kind === 'fresh',
  );
  if (fresh.length > 0) {
    const count = fresh.length === 1 ? '1 Channel' : `${fresh.length} Channels`;
    const carried = fresh.some((channel) => channel.nextTurn.carriesOver)
      ? ", with that Channel's recent messages"
      : '';
    return `Its next turn in ${count} starts a fresh Session${carried}.`;
  }
  if (changedWithinSession && agent.channels.length > 0) {
    return 'The change applies from the next turn of the same Session.';
  }
  return null;
}

function folder(agent: AgentView): string {
  return agent.workingDirectory === null
    ? `${agent.effectiveWorkingDirectory} (default)`
    : agent.effectiveWorkingDirectory;
}

function title(channel: AgentChannelView): string {
  const name = channel.title ?? '—';
  return channel.enabled ? name : `${name} (disabled)`;
}
