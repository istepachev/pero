import { describe, expect, it } from 'vitest';
import type { AgentDetails, AgentView } from '../control/protocol.js';
import {
  describeNextTurn,
  formatAgentDetails,
  formatAgentList,
} from './format-agents.js';

const notes: AgentView = {
  name: 'notes',
  title: 'Notes',
  provider: 'claude',
  model: null,
  effort: null,
  workingDirectory: null,
  effectiveWorkingDirectory: '/home/ws',
  instructions: null,
  useMainInstructions: false,
  permissions: 'ask',
  skipGitRepoCheck: false,
  enabled: true,
  main: true,
  file: 'data/Settings/Agents/Notes.md',
  topic: null,
  origins: {
    provider: 'default',
    model: 'default',
    effort: 'default',
    permissions: 'default',
    workingDirectory: 'workspace',
  },
  errors: [],
};

const health: AgentView = {
  ...notes,
  name: 'health',
  title: 'Health',
  model: 'sonnet',
  effort: 'high',
  workingDirectory: '/ws/data/Health',
  effectiveWorkingDirectory: '/ws/data/Health',
  instructions: 'Coach me.',
  main: false,
  file: 'data/Settings/Agents/Health.md',
  topic: 'Health',
  useMainInstructions: true,
  origins: {
    provider: 'default',
    model: 'note',
    effort: 'pero',
    permissions: 'pero',
    workingDirectory: 'note',
  },
  errors: [
    {
      property: 'effort',
      message: 'must be low, medium, high, xhigh, or max for claude',
    },
  ],
};

const coder: AgentView = {
  ...notes,
  name: 'coder',
  title: 'Coder',
  provider: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
  workingDirectory: '/srv/code',
  effectiveWorkingDirectory: '/srv/code',
  instructions: 'Write tests first.\nKeep it short.',
  useMainInstructions: false,
  permissions: 'bypass',
  skipGitRepoCheck: true,
  enabled: false,
  main: false,
  file: 'data/Settings/Agents/Coder.md',
  topic: 'Code',
  origins: {
    provider: 'note',
    model: 'note',
    effort: 'note',
    permissions: 'note',
    workingDirectory: 'note',
  },
};

const resume = {
  kind: 'resume' as const,
  reason: null,
  from: null,
  sessionId: 4,
  carriesOver: false,
};

describe('formatAgentList', () => {
  it('lists each Agent with its topic and note, the main one marked', () => {
    expect(formatAgentList([coder, notes])).toBe(
      [
        'NAME     PROVIDER  MODEL    EFFORT   FOLDER                PERMISSIONS  STATE     TOPIC  NOTE',
        'coder    codex     gpt-5.5  high     /srv/code             bypass       disabled  Code   data/Settings/Agents/Coder.md',
        'notes *  claude    default  default  /home/ws (workspace)  ask          enabled   —      data/Settings/Agents/Notes.md',
        '',
        '* the main Agent: General topics and direct chats',
      ].join('\n'),
    );
  });

  it('says how to create the first Agent', () => {
    expect(formatAgentList([])).toBe(
      'No Agents yet. Add a note to the Agents folder in the settings folder.',
    );
  });

  it('marks notes with errors', () => {
    expect(formatAgentList([health, { ...notes, model: 'opus' }])).toBe(
      [
        'NAME      PROVIDER  MODEL   EFFORT   FOLDER                PERMISSIONS  STATE    TOPIC   NOTE',
        'health !  claude    sonnet  high     /ws/data/Health       ask          enabled  Health  data/Settings/Agents/Health.md',
        'notes *   claude    opus    default  /home/ws (workspace)  ask          enabled  —       data/Settings/Agents/Notes.md',
        '',
        '* the main Agent: General topics and direct chats',
        '! its note has errors, so its last good version is in use; pero check lists them',
      ].join('\n'),
    );
  });
});

describe('formatAgentDetails', () => {
  it('shows the note, its topic, where each value comes from, and its errors', () => {
    expect(
      formatAgentDetails({
        ...health,
        channels: [],
        folderProblem: null,
      }),
    ).toBe(
      [
        'Agent health "Health"',
        '  note               data/Settings/Agents/Health.md',
        '  topic              Health',
        '  provider           claude (default)',
        '  model              sonnet',
        '  effort             high (Pero.md)',
        '  working directory  /ws/data/Health',
        '  instructions       Coach me.',
        '  main instructions  on',
        '  permissions        ask (Pero.md)',
        '  codex git check    required',
        '  state              enabled',
        '  main agent         no',
        '',
        'Its note has errors, so its last good version is in use:',
        '  effort: must be low, medium, high, xhigh, or max for claude',
        '',
        'No Channel goes to it yet.',
      ].join('\n'),
    );
  });

  it("shows the settings and each Channel's next turn", () => {
    const details: AgentDetails = {
      ...coder,
      folderProblem: 'Working directory /srv/code does not exist',
      channels: [
        {
          id: 3,
          integrationKind: 'telegram',
          key: '-1001:12',
          title: 'Code',
          nextTurn: resume,
        },
        {
          id: 5,
          integrationKind: 'telegram',
          key: '-1001:14',
          title: null,
          nextTurn: {
            kind: 'fresh',
            reason: 'provider',
            from: 'claude',
            sessionId: 6,
            carriesOver: true,
          },
        },
      ],
    };
    expect(formatAgentDetails(details)).toBe(
      [
        'Agent coder "Coder"',
        '  note               data/Settings/Agents/Coder.md',
        '  topic              Code',
        '  provider           codex',
        '  model              gpt-5.5',
        '  effort             high',
        '  working directory  /srv/code',
        '  instructions       Write tests first. (2 lines)',
        '  main instructions  off',
        '  permissions        bypass',
        '  codex git check    skipped',
        '  state              disabled',
        '  main agent         no',
        '',
        'Warning: Working directory /srv/code does not exist',
        '',
        'Channels',
        '  ID  CHANNEL            TITLE  NEXT TURN',
        '  3   telegram -1001:12  Code   resumes Session 4',
        "  5   telegram -1001:14  —      fresh Session: provider was claude, with the Channel's recent messages",
      ].join('\n'),
    );
  });

  it('says when no Channel goes to it', () => {
    expect(
      formatAgentDetails({ ...notes, channels: [], folderProblem: null }),
    ).toMatch(
      /main agent +yes: General topics and direct chats\n\nNo Channel goes to it yet\.$/,
    );
  });
});

describe('describeNextTurn', () => {
  it('describes each kind', () => {
    expect(describeNextTurn({ ...resume, kind: 'new', sessionId: null })).toBe(
      'starts its first Session',
    );
    expect(
      describeNextTurn({ ...resume, kind: 'restart', carriesOver: true }),
    ).toBe("starts Session 4 over, with the Channel's recent messages");
    expect(
      describeNextTurn({
        ...resume,
        kind: 'fresh',
        reason: 'folder',
        from: '/vault',
      }),
    ).toBe('fresh Session: folder was /vault');
  });
});
