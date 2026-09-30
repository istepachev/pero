import type { AgentDetails, AgentView, NextTurn } from '../control/protocol.js';
import type { ValueOrigin } from '../settings-files/origins.js';
import { table } from './format-status.js';
import { preview } from './settings-keys.js';

const DEFAULT = 'default';

/** `pero agents ls`: one row per Agent, the main one marked. */
export function formatAgentList(agents: readonly AgentView[]): string {
  if (agents.length === 0) {
    return 'No Agents yet. Add a note to the Agents folder in the settings folder.';
  }
  const notes = agents.some((agent) => agent.file !== null);
  const lines = table([
    [
      'NAME',
      'PROVIDER',
      'MODEL',
      'EFFORT',
      'FOLDER',
      'PERMISSIONS',
      'STATE',
      ...(notes ? ['TOPICS', 'NOTE'] : []),
    ],
    ...agents.map((agent) => [
      `${agent.name}${agent.main ? ' *' : ''}${agent.errors.length > 0 ? ' !' : ''}`,
      agent.provider,
      agent.model ?? DEFAULT,
      agent.effort ?? DEFAULT,
      folder(agent),
      agent.permissions,
      agent.enabled ? 'enabled' : 'disabled',
      ...(notes ? [agent.topics.join(', ') || '—', agent.file ?? '—'] : []),
    ]),
  ]);
  const footnotes = [
    ...(agents.some((agent) => agent.main)
      ? ['* the main Agent: General topics and direct chats']
      : []),
    ...(agents.some((agent) => agent.errors.length > 0)
      ? [
          '! its note has errors, so its last good version is in use; pero check lists them',
        ]
      : []),
  ];
  if (footnotes.length > 0) lines.push('', ...footnotes);
  return lines.join('\n');
}

/** `pero agents show`: settings, then each Channel's next turn. */
export function formatAgentDetails(agent: AgentDetails): string {
  const from = (origin: ValueOrigin | undefined) =>
    origin === 'pero' ? ' (Pero.md)' : origin === 'default' ? ' (default)' : '';
  const option = (value: string | null, origin: ValueOrigin | undefined) =>
    value === null ? '(provider default)' : `${value}${from(origin)}`;
  const { origins } = agent;
  const lines = [
    `Agent ${agent.name}${agent.title === null ? '' : ` "${agent.title}"`}`,
    ...table([
      ...(agent.file === null
        ? []
        : [
            ['note', agent.file],
            ['topics', agent.topics.join(', ') || '(none)'],
          ]),
      ['provider', `${agent.provider}${from(origins?.provider)}`],
      ['model', option(agent.model, origins?.model)],
      ['effort', option(agent.effort, origins?.effort)],
      ['working directory', folder(agent)],
      ['instructions', preview(agent.instructions)],
      ['shared instructions', agent.useSharedInstructions ? 'on' : 'off'],
      ['permissions', `${agent.permissions}${from(origins?.permissions)}`],
      ['codex git check', agent.codexSkipGitRepoCheck ? 'skipped' : 'required'],
      ['state', agent.enabled ? 'enabled' : 'disabled'],
      [
        'main agent',
        agent.main ? 'yes: General topics and direct chats' : 'no',
      ],
    ]).map((row) => `  ${row}`),
  ];
  if (agent.errors.length > 0) {
    lines.push(
      '',
      'Its note has errors, so its last good version is in use:',
      ...agent.errors.map(
        ({ property, message }) =>
          `  ${property === null ? '' : `${property}: `}${message}`,
      ),
    );
  }
  if (agent.folderProblem !== null) {
    lines.push('', `Warning: ${agent.folderProblem}`);
  }
  lines.push('');
  if (agent.channels.length === 0) {
    lines.push('No Channel goes to it yet.');
  } else {
    lines.push(
      'Channels',
      ...table([
        ['ID', 'CHANNEL', 'TITLE', 'NEXT TURN'],
        ...agent.channels.map((channel) => [
          String(channel.id),
          `${channel.integrationKind} ${channel.key}`,
          channel.title ?? '—',
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

function folder(agent: AgentView): string {
  if (agent.workingDirectory !== null) return agent.effectiveWorkingDirectory;
  return `${agent.effectiveWorkingDirectory} (${agent.origins === null ? 'default' : 'data folder'})`;
}
