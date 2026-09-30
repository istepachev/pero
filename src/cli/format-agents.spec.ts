import { describe, expect, it } from 'vitest';
import type { AgentDetails, AgentView } from '../control/protocol.js';
import {
  describeNextTurn,
  formatAgentDetails,
  formatAgentList,
} from './format-agents.js';

const notes: AgentView = {
  name: 'notes',
  title: null,
  provider: 'claude',
  model: null,
  effort: null,
  workingDirectory: null,
  effectiveWorkingDirectory: '/vault',
  instructions: null,
  useSharedInstructions: true,
  permissions: 'ask',
  codexSkipGitRepoCheck: false,
  enabled: true,
  main: true,
  file: null,
  topics: [],
  origins: null,
  errors: [],
};

const fromNote = {
  model: 'opus',
  file: 'data/Settings/Agents/Main.md',
  origins: {
    provider: 'default',
    model: 'pero',
    effort: 'default',
    permissions: 'default',
    workingDirectory: 'data',
  },
} satisfies Partial<AgentView>;

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
  topics: ['Health', 'Running'],
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
  useSharedInstructions: false,
  permissions: 'bypass',
  codexSkipGitRepoCheck: true,
  enabled: false,
  main: false,
};

const resume = {
  kind: 'resume' as const,
  reason: null,
  from: null,
  sessionId: 4,
  carriesOver: false,
};

describe('formatAgentList', () => {
  it('lists each Agent with the main one marked', () => {
    expect(formatAgentList([coder, notes])).toBe(
      [
        'NAME     PROVIDER  MODEL    EFFORT   FOLDER            PERMISSIONS  STATE',
        'coder    codex     gpt-5.5  high     /srv/code         bypass       disabled',
        'notes *  claude    default  default  /vault (default)  ask          enabled',
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

  it('shows the topics and note of each, and marks notes with errors', () => {
    expect(formatAgentList([health, { ...notes, ...fromNote }])).toBe(
      [
        'NAME      PROVIDER  MODEL   EFFORT   FOLDER                PERMISSIONS  STATE    TOPICS           NOTE',
        'health !  claude    sonnet  high     /ws/data/Health       ask          enabled  Health, Running  data/Settings/Agents/Health.md',
        'notes *   claude    opus    default  /vault (data folder)  ask          enabled  —                data/Settings/Agents/Main.md',
        '',
        '* the main Agent: General topics and direct chats',
        '! its note has errors, so its last good version is in use; pero check lists them',
      ].join('\n'),
    );
  });
});

describe('formatAgentDetails in a workspace', () => {
  it('shows the note, its topics, where each value comes from, and its errors', () => {
    expect(
      formatAgentDetails({
        ...health,
        channels: [],
        folderProblem: null,
      }),
    ).toBe(
      [
        'Agent health "Health"',
        '  note                 data/Settings/Agents/Health.md',
        '  topics               Health, Running',
        '  provider             claude (default)',
        '  model                sonnet',
        '  effort               high (Pero.md)',
        '  working directory    /ws/data/Health',
        '  instructions         Coach me.',
        '  shared instructions  on',
        '  permissions          ask (Pero.md)',
        '  codex git check      required',
        '  state                enabled',
        '  main agent           no',
        '',
        'Its note has errors, so its last good version is in use:',
        '  effort: must be low, medium, high, xhigh, or max for claude',
        '',
        'No Channel is assigned to it yet.',
      ].join('\n'),
    );
  });
});

describe('formatAgentDetails', () => {
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
          enabled: true,
          nextTurn: resume,
        },
        {
          id: 5,
          integrationKind: 'telegram',
          key: '-1001:14',
          title: null,
          enabled: false,
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
        '  provider             codex',
        '  model                gpt-5.5',
        '  effort               high',
        '  working directory    /srv/code',
        '  instructions         Write tests first. (2 lines)',
        '  shared instructions  off',
        '  permissions          bypass',
        '  codex git check      skipped',
        '  state                disabled',
        '  main agent           no',
        '',
        'Warning: Working directory /srv/code does not exist',
        '',
        'Channels',
        '  ID  CHANNEL            TITLE         NEXT TURN',
        '  3   telegram -1001:12  Code          resumes Session 4',
        "  5   telegram -1001:14  — (disabled)  fresh Session: provider was claude, with the Channel's recent messages",
      ].join('\n'),
    );
  });

  it('says when no Channel is assigned', () => {
    expect(
      formatAgentDetails({ ...notes, channels: [], folderProblem: null }),
    ).toMatch(
      /main agent +yes: General topics and direct chats\n\nNo Channel is assigned to it yet\.$/,
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
