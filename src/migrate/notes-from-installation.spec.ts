import { describe, expect, it } from 'vitest';
import type {
  AgentDefinition,
  WorkflowDefinition,
} from '../definitions/definitions.js';
import type {
  Installation,
  InstallationChannel,
} from '../definitions/installation.js';
import { fileTitle, planNotes } from './notes-from-installation.js';

function agent(
  name: string,
  fields: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name,
    title: null,
    provider: 'claude',
    providerOptions: { model: null, effort: null },
    permissions: 'ask',
    workingDirectory: '/vault',
    ownWorkingDirectory: null,
    instructions: null,
    sharedInstructions: true,
    skipGitRepoCheck: false,
    enabled: true,
    ...fields,
  };
}

function workflow(
  name: string,
  fields: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    name,
    title: null,
    agent: 'main',
    input: 'Go.',
    history: null,
    targets: [],
    maxAttempts: 1,
    schedules: [],
    enabled: true,
    ...fields,
  };
}

let nextChannel = 1;

function channel(
  key: string,
  title: string | null,
  agentName: string,
): InstallationChannel {
  return { id: nextChannel++, key, title, agent: agentName, enabled: true };
}

function installation(fields: Partial<Installation> = {}): Installation {
  return {
    defaults: {
      provider: 'claude',
      providerDefaults: {
        claude: { model: null, effort: null },
        codex: { model: null, effort: null },
      },
      permissions: 'ask',
      timezone: 'UTC',
      historyCarryover: 50,
      historyRetentionDays: null,
      maxConcurrentRuns: 2,
      dataFolder: '/vault',
      sharedInstructions: null,
    },
    agents: [agent('main')],
    mainAgent: 'main',
    workflows: [],
    triggers: [],
    channels: [],
    allowedChats: [],
    ...fields,
  };
}

const ALLOWED = { allowedChats: new Set(['-100', '7']) };

describe('fileTitle', () => {
  it('uses the title when it makes the same name, and the name otherwise', () => {
    expect(fileTitle('Weekly Health', 'weekly-health')).toBe('Weekly Health');
    expect(fileTitle('Здоровье', 'zdorove')).toBe('Здоровье');
    expect(fileTitle('Health', 'health-2')).toBe('health-2');
    expect(fileTitle(null, 'coach')).toBe('coach');
    expect(fileTitle('  ', 'coach')).toBe('coach');
  });

  it('never makes a file name that is unsafe or ignored', () => {
    expect(fileTitle('Home: Health', 'home-health')).toBe('home-health');
    expect(fileTitle('Home/Health', 'home-health')).toBe('home-health');
    expect(fileTitle('_Draft', 'draft')).toBe('draft');
    expect(fileTitle('.Hidden', 'hidden')).toBe('hidden');
  });
});

describe('planNotes', () => {
  it('writes only Pero.md and the Agents of a fresh installation', () => {
    const plan = planNotes(installation(), ALLOWED);
    expect(plan).toEqual({
      notes: [
        { path: 'Pero.md', text: '---\ntimezone: UTC\n---\n' },
        { path: 'Agents/main.md', text: '' },
      ],
      splits: [],
      notices: [],
      conflicts: [],
    });
  });

  it('says which topics and chats notes cannot route as before', () => {
    const plan = planNotes(
      installation({
        agents: [agent('main'), agent('coach')],
        channels: [
          channel('-100', 'Home', 'coach'),
          channel('-100:2', null, 'coach'),
          channel('-100:3', 'general', 'coach'),
          channel('-100:4', 'Sport', 'coach'),
          channel('-200:4', 'Sport', 'main'),
        ],
      }),
      ALLOWED,
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.notices).toEqual([
      "Chat Home was answered by coach; a chat's General topic and direct chats go to the main Agent, main, now.",
      'Topic -100:2 (Channel 2) has no title Pero has seen, so no note can claim it: it goes to a new Agent or the main Agent. Its Agent was coach.',
      "Topic Home/general can't be claimed by its title, which names a chat's General topic; its Agent was coach.",
    ]);
    expect(plan.notes.find((note) => note.path === 'Agents/coach.md')).toEqual({
      path: 'Agents/coach.md',
      text: '---\ntopics:\n  - Sport\n---\n',
    });
  });

  it('stops on a split name another Workflow has', () => {
    const plan = planNotes(
      installation({
        workflows: [workflow('brief'), workflow('brief-2')],
        triggers: [1, 2].map((id) => ({
          id,
          workflow: 'brief',
          kind: 'schedule' as const,
          cron: `0 ${id} * * *`,
          timezone: 'UTC',
          enabled: true,
        })),
      }),
      ALLOWED,
    );
    expect(plan.conflicts).toEqual([
      "Workflow brief has 2 schedules, and would become one Workflow each, but brief-2 can't be the name of one: another Workflow has it. Rename one of them first.",
    ]);
  });

  it('names a direct chat by its Channel ID, and a topic by its title', () => {
    const topic = channel('-100:5', 'Health', 'main');
    const direct = channel('7', 'Vit', 'main');
    const plan = planNotes(
      installation({
        channels: [topic, direct],
        workflows: [workflow('brief', { targets: [topic.id, direct.id] })],
      }),
      ALLOWED,
    );
    expect(plan.notes.at(-1)).toEqual({
      path: 'Workflows/brief.md',
      text: `---\nagent: main\nchannel:\n  - Health\n  - ${direct.id}\n---\nGo.\n`,
    });
  });
});
