import { describe, expect, it } from 'vitest';
import type { AgentDetails, AgentView } from '../control/protocol.js';
import {
  describeNextTurn,
  formatAgentDetails,
  formatAgentList,
  sessionEffect,
  summarize,
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
      'No Agents yet. Create a topic in an allowed Telegram group, or run pero agents create <name>.',
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

describe('summarize', () => {
  it('names the provider, model, effort, and folder', () => {
    expect(summarize(notes)).toBe(
      'claude, default model, default effort, working in /vault (default)',
    );
    expect(summarize(coder)).toBe(
      'codex, gpt-5.5, high effort, working in /srv/code',
    );
  });
});

describe('sessionEffect', () => {
  const channel = {
    id: 1,
    integrationKind: 'telegram' as const,
    key: '1',
    title: null,
    enabled: true,
    nextTurn: resume,
  };
  const details = (...channels: AgentDetails['channels']): AgentDetails => ({
    ...notes,
    folderProblem: null,
    channels,
  });

  it('counts the Channels that start a fresh Session', () => {
    const fresh = {
      ...channel,
      nextTurn: {
        ...resume,
        kind: 'fresh' as const,
        reason: 'provider' as const,
        from: 'codex',
        carriesOver: true,
      },
    };
    expect(sessionEffect(details(fresh, fresh, channel), false)).toBe(
      "Its next turn in 2 Channels starts a fresh Session, with that Channel's recent messages.",
    );
  });

  it('says a change within the Session applies from its next turn', () => {
    expect(sessionEffect(details(channel), true)).toBe(
      'The change applies from the next turn of the same Session.',
    );
    expect(sessionEffect(details(channel), false)).toBeNull();
    expect(sessionEffect(details(), true)).toBeNull();
  });
});
