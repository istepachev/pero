import { describe, expect, it } from 'vitest';
import type { ChannelRef } from './schemas.js';
import {
  buildSnapshot,
  type SnapshotContext,
  type TopicLookup,
  topicClaim,
  type TopicResolution,
} from './snapshot.js';

const CONTEXT: SnapshotContext = {
  workspace: '/home/me/workspace',
  dataFolder: '/home/me/workspace/data',
  homeDir: '/home/me',
  hostTimeZone: 'UTC',
};

/** A snapshot of the notes in `files`, keyed by path. */
function snapshot(
  files: Record<string, string>,
  context: Partial<SnapshotContext> = {},
) {
  return buildSnapshot(
    Object.entries(files).map(([file, text]) => ({ file, text })),
    { ...CONTEXT, ...context },
  );
}

/** Each error as `file property: message`, for compact assertions. */
function errorsOf(files: Record<string, string>, context = {}) {
  return snapshot(files, context).errors.map(
    (error) => `${error.file} ${error.property ?? '-'}: ${error.message}`,
  );
}

const WEEKLY = `---
day: sunday
hour: 12
channel: Health
---
Create a weekly report.`;

describe('buildSnapshot', () => {
  it('has only defaults and no errors for an empty folder', () => {
    const result = snapshot({});
    expect(result.defaults).toEqual({
      provider: 'claude',
      providerDefaults: {
        claude: { model: null, effort: null },
        codex: { model: null, effort: null },
      },
      permissions: 'ask',
      timezone: 'UTC',
      mainAgent: 'main',
      newTopics: 'create-agent',
      historyCarryover: 50,
      historyRetentionDays: null,
      maxConcurrentRuns: 2,
    });
    expect(result.sharedInstructions).toBeNull();
    expect(result.peroProperties.size).toBe(0);
    expect(result.agents.size).toBe(0);
    expect(result.workflows.size).toBe(0);
    expect(result.mainAgent).toBe('main');
    expect(result.errors).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('builds the workspace in five notes from the overview', () => {
    const result = snapshot({
      'Pero.md': `---
provider: claude
claude-model: opus
permissions: ask
timezone: Europe/Berlin
---
You are a calm, concise personal assistant.`,
      'Agents/Main.md': 'You help with everyday questions.',
      'Agents/Health.md': `---
topics: [Health]
effort: high
---
You are my health coach.`,
      'Workflows/Weekly health report.md': WEEKLY,
    });
    expect(result.errors).toEqual([]);
    expect(result.sharedInstructions).toBe(
      'You are a calm, concise personal assistant.',
    );
    expect(result.agents.get('main')).toMatchObject({
      name: 'main',
      title: 'Main',
      file: 'Agents/Main.md',
      topics: [],
      provider: 'claude',
      model: 'opus',
      effort: null,
      permissions: 'ask',
      workingDirectory: '/home/me/workspace/data',
      instructions: 'You help with everyday questions.',
    });
    expect(result.agents.get('health')).toMatchObject({
      topics: ['Health'],
      model: 'opus',
      effort: 'high',
      note: expect.objectContaining({ model: null, effort: 'high' }),
    });
    expect(result.topicClaims).toEqual(new Map([['health', 'health']]));
    expect(result.workflows.get('weekly-health-report')).toEqual({
      name: 'weekly-health-report',
      title: 'Weekly health report',
      file: 'Workflows/Weekly health report.md',
      agent: 'health',
      trigger: 'schedule',
      schedule: { cron: '0 12 * * 0', timezone: 'Europe/Berlin' },
      channels: ['Health'],
      history: null,
      resolved: null,
      maxAttempts: 1,
      enabled: true,
      input: 'Create a weekly report.',
    });
  });

  it('applies Pero.md defaults for the Agent’s own provider', () => {
    const result = snapshot({
      'Pero.md': `---
provider: codex
codex-model: gpt-5.5
codex-effort: minimal
claude-model: sonnet
permissions: bypass
---`,
      'Agents/Coder.md': '',
      'Agents/Writer.md': '---\nprovider: claude\npermissions: ask\n---',
    });
    expect(result.agents.get('coder')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'minimal',
      permissions: 'bypass',
    });
    expect(result.agents.get('writer')).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      effort: null,
      permissions: 'ask',
    });
  });

  it('resolves working directories against the workspace', () => {
    const folder = (path: string) =>
      snapshot({
        'Agents/Site.md': `---\nworking-directory: ${path}\n---`,
      }).agents.get('site')!.workingDirectory;
    expect(folder('projects/site')).toBe('/home/me/workspace/projects/site');
    expect(folder('~/code')).toBe('/home/me/code');
    expect(folder('/srv/site')).toBe('/srv/site');
  });

  it('reads notes in subfolders and skips ignored ones', () => {
    const result = snapshot({
      'Agents/Coaches/Running.md': '---\ntopics: Running\n---',
      'Agents/_Template.md': '---\nmodle: broken\n---',
      'Agents/.draft.md': 'not read',
      '.obsidian/app.md': 'not read',
      'Agents/notes.txt': 'not read',
      'Workflows/_Ideas.md': '---\nhour: 99\n---',
    });
    expect(result.errors).toEqual([]);
    expect([...result.agents.keys()]).toEqual(['running']);
    expect(result.agents.get('running')!.file).toBe(
      'Agents/Coaches/Running.md',
    );
  });

  it('reports a note outside Agents/ and Workflows/', () => {
    expect(errorsOf({ 'Agent/Health.md': 'Hi' })).toEqual([
      'Agent/Health.md -: not an Agent or Workflow note; move it under Agents/ or Workflows/, or start its name with _',
    ]);
  });

  it('leaves out both notes of a duplicate name, and what depends on them', () => {
    const result = snapshot({
      'Agents/Health.md': 'One',
      'Agents/Old/health.md': 'Two',
      'Agents/Café.md': 'Three',
      'Agents/Cafe.md': 'Four',
      'Workflows/Report.md': '---\nagent: Health\n---\nGo',
    });
    expect(result.agents.size).toBe(0);
    expect(result.workflows.size).toBe(0);
    expect(
      errorsOf({
        'Agents/Health.md': 'One',
        'Agents/Old/health.md': 'Two',
        'Workflows/Report.md': '---\nagent: Health\n---\nGo',
      }),
    ).toEqual([
      'Agents/Health.md -: has the same name, health, as Agents/Old/health.md; rename one of them',
      'Agents/Old/health.md -: has the same name, health, as Agents/Health.md; rename one of them',
      'Workflows/Report.md agent: the Agent note named health has errors',
    ]);
  });

  it('lets an Agent and a Workflow share a name', () => {
    const result = snapshot({
      'Agents/Review.md': 'Agent',
      'Workflows/Review.md': 'Workflow',
    });
    expect(result.errors).toEqual([]);
    expect(result.agents.has('review')).toBe(true);
    expect(result.workflows.has('review')).toBe(true);
  });

  it('answers a topic claimed twice with neither Agent, and reports both', () => {
    const files = {
      'Agents/Health.md': '---\ntopics: [Health, Sleep]\n---',
      'Agents/Running.md': '---\ntopics: [health, Running]\n---',
    };
    const result = snapshot(files);
    expect([...result.agents.keys()].sort()).toEqual(['health', 'running']);
    expect(result.conflictedTopics).toEqual(new Set(['health']));
    expect(result.topicClaims).toEqual(
      new Map([
        ['sleep', 'health'],
        ['running', 'running'],
      ]),
    );
    expect(errorsOf(files)).toEqual([
      'Agents/Health.md topics: "Health" is also claimed by Agents/Running.md, so neither answers there',
      'Agents/Running.md topics: "health" is also claimed by Agents/Health.md, so neither answers there',
    ]);
  });

  it('records the topics of Agent notes left out for errors', () => {
    const result = snapshot({
      'Agents/Health.md': '---\ntopics: [Health, Sleep]\neffort: extreme\n---',
      'Agents/Coach.md': '---\ntopics: Running\nmodle: x\n---',
      'Agents/Sleep.md': '---\ntopics: Sleep\n---',
      'Agents/a/Chat.md': '---\ntopics: Chat\n---',
      'Agents/b/Chat.md': '---\ntopics: [Chat, Talk]\n---',
      'Agents/Broken.md': '---\ntopics: [\n---',
    });
    expect(result.unloadedTopics).toEqual(
      new Map([
        ['health', ['Agents/Health.md']],
        ['running', ['Agents/Coach.md']],
        ['chat', ['Agents/a/Chat.md', 'Agents/b/Chat.md']],
        ['talk', ['Agents/b/Chat.md']],
      ]),
    );
    // Sleep is claimed by a note that loaded.
    expect(result.topicClaims.get('sleep')).toBe('sleep');
  });

  it('keeps a note loaded from its last good version out of unloaded topics', () => {
    const result = buildSnapshot(
      [
        {
          file: 'Agents/Health.md',
          text: '---\ntopics: Health\nmodle: x\n---',
          fallback: '---\ntopics: Health\n---',
        },
      ],
      CONTEXT,
    );
    expect(result.unloadedTopics.size).toBe(0);
    expect(result.topicClaims.get('health')).toBe('health');
  });

  it('tells who answers a topic by its title', () => {
    const result = snapshot({
      'Agents/Health.md': '---\ntopics: [Health, Sleep]\n---',
      'Agents/Running.md': '---\ntopics: [sleep]\n---',
      'Agents/Coach.md': '---\ntopics: Coaching\nmodle: x\n---',
    });
    expect(topicClaim(result, ' HEALTH ')).toEqual({
      kind: 'agent',
      agent: 'health',
    });
    expect(topicClaim(result, 'Sleep')).toEqual({
      kind: 'conflict',
      files: ['Agents/Health.md', 'Agents/Running.md'],
    });
    expect(topicClaim(result, 'coaching')).toEqual({
      kind: 'unloaded',
      files: ['Agents/Coach.md'],
    });
    expect(topicClaim(result, 'Groceries')).toEqual({ kind: 'unclaimed' });
  });

  it('lets a disabled Agent keep its topics', () => {
    const result = snapshot({
      'Agents/Health.md': '---\ntopics: Health\nenabled: false\n---',
    });
    expect(result.topicClaims.get('health')).toBe('health');
  });

  describe('the main Agent', () => {
    it('may be missing while it is the default', () => {
      const result = snapshot({ 'Agents/Health.md': 'Hi' });
      expect(result.mainAgent).toBe('main');
      expect(result.errors).toEqual([]);
    });

    it('must exist when Pero.md names it', () => {
      expect(errorsOf({ 'Pero.md': '---\nmain-agent: Home\n---' })).toEqual([
        'Pero.md main-agent: no Agent note is named home',
      ]);
      expect(
        snapshot({
          'Pero.md': '---\nmain-agent: Home\n---',
          'Agents/Home.md': 'Hi',
        }).errors,
      ).toEqual([]);
    });

    it('must load when Pero.md names it', () => {
      expect(
        errorsOf({
          'Pero.md': '---\nmain-agent: Home\n---',
          'Agents/Home.md': '---\nmodle: x\n---',
        }),
      ).toEqual([
        'Agents/Home.md modle: unknown property (did you mean model?)',
        'Pero.md main-agent: the Agent note named home has errors',
      ]);
    });
  });

  it('keeps the Agents when Pero.md is broken, with all defaults', () => {
    const files = {
      'Pero.md': '---\nprovider: gemini\ntimezone: Asia/Tokyo\n---\nShared',
      'Agents/Main.md': 'Hi',
    };
    const result = snapshot(files);
    expect(result.defaults).toMatchObject({
      provider: 'claude',
      timezone: 'UTC',
    });
    expect(result.sharedInstructions).toBeNull();
    expect(result.agents.has('main')).toBe(true);
    expect(errorsOf(files)).toEqual([
      'Pero.md provider: must be claude or codex',
    ]);
  });

  it('checks an Agent’s effort against its provider', () => {
    const files = {
      'Pero.md': '---\nprovider: codex\n---',
      'Agents/Deep.md': '---\neffort: ultra\n---',
      'Agents/Quick.md': '---\nprovider: claude\neffort: minimal\n---',
    };
    const result = snapshot(files);
    expect(result.agents.get('deep')!.effort).toBe('ultra');
    expect(result.agents.has('quick')).toBe(false);
    expect(errorsOf(files)).toEqual([
      'Agents/Quick.md effort: must be low, medium, high, xhigh, or max for claude',
    ]);
  });

  it('leaves out a note that does not parse, with its errors', () => {
    const files = {
      'Agents/Health.md': '---\ntopics: [Health\n---',
      'Agents/Main.md': 'Hi',
    };
    const result = snapshot(files);
    expect([...result.agents.keys()]).toEqual(['main']);
    expect(result.errors).toEqual([
      expect.objectContaining({ file: 'Agents/Health.md', property: null }),
    ]);
  });

  describe('Workflows', () => {
    it('are left out when their Agent is missing or broken', () => {
      const files = {
        'Agents/Health.md': '---\nprovider: gemini\n---',
        'Workflows/Report.md': '---\nagent: Health\n---\nGo',
        'Workflows/Review.md': '---\nagent: Coach\n---\nGo',
      };
      const result = snapshot(files);
      expect(result.workflows.size).toBe(0);
      expect(errorsOf(files)).toEqual([
        'Agents/Health.md provider: must be claude or codex',
        'Workflows/Report.md agent: the Agent note named health has errors',
        'Workflows/Review.md agent: no Agent note is named coach',
      ]);
    });

    it('run with a disabled Agent', () => {
      const result = snapshot({
        'Agents/Health.md': '---\nenabled: false\n---',
        'Workflows/Report.md': '---\nagent: Health\n---\nGo',
      });
      expect(result.workflows.get('report')!.agent).toBe('health');
    });

    it('take the Agent from their first channel', () => {
      const agentOf = (channel: string) =>
        snapshot({
          'Agents/Health.md': '---\ntopics: [Health]\n---',
          'Workflows/Report.md': `---\nchannel: ${channel}\n---\nGo`,
        }).workflows.get('report')!.agent;
      expect(agentOf('Health')).toBe('health');
      expect(agentOf('[health, Other]')).toBe('health');
      expect(agentOf('Home/Health')).toBe('health');
      expect(agentOf('General')).toBe('main');
      expect(agentOf('Finance')).toBe('main');
      expect(agentOf('[Finance, Health]')).toBe('main');
      expect(agentOf('5')).toBeNull();
    });

    it('fall back to the main Agent without a channel', () => {
      expect(
        snapshot({
          'Pero.md': '---\nmain-agent: Home\n---',
          'Agents/Home.md': 'Hi',
          'Workflows/Report.md': 'Go',
        }).workflows.get('report')!.agent,
      ).toBe('home');
    });

    it('need an agent when their first channel is claimed twice', () => {
      const files = {
        'Agents/Health.md': '---\ntopics: Health\n---',
        'Agents/Running.md': '---\ntopics: Health\n---',
        'Workflows/Report.md': '---\nchannel: Health\n---\nGo',
      };
      expect(snapshot(files).workflows.size).toBe(0);
      expect(errorsOf(files)).toContain(
        'Workflows/Report.md channel: "Health" is claimed by more than one Agent; set agent',
      );
    });

    it('check chat/topic syntax without a lookup', () => {
      const files = {
        'Workflows/Report.md':
          '---\nchannel: Home/\nhistory: true\nhistory-channels: /Health\n---\nGo',
      };
      expect(errorsOf(files)).toEqual([
        'Workflows/Report.md channel: "Home/" must be a topic title or <chat title>/<topic title>',
        'Workflows/Report.md history-channels: "/Health" must be a topic title or <chat title>/<topic title>',
      ]);
    });

    it('take their schedule time zone from Pero.md or the host', () => {
      const zone = (files: Record<string, string>) =>
        snapshot({ 'Workflows/Report.md': WEEKLY, ...files }).workflows.get(
          'report',
        )!.schedule!.timezone;
      expect(zone({})).toBe('UTC');
      expect(zone({ 'Pero.md': '---\ntimezone: Asia/Tokyo\n---' })).toBe(
        'Asia/Tokyo',
      );
      expect(
        zone({
          'Workflows/Report.md': `---\nhour: 9\ntimezone: America/New_York\n---\nGo`,
        }),
      ).toBe('America/New_York');
    });
  });

  describe('with a topic lookup', () => {
    const channels: Record<string, TopicResolution> = {
      health: {
        kind: 'ok',
        channel: { id: 3, primary: false, title: 'Health' },
      },
      general: {
        kind: 'ok',
        channel: { id: 1, primary: true, title: 'Home' },
      },
      '7': {
        kind: 'ok',
        channel: { id: 7, primary: false, title: 'Health' },
      },
      '8': { kind: 'ok', channel: { id: 8, primary: true, title: 'Me' } },
      english: {
        kind: 'ambiguous',
        matches: ['Home/English', 'Work/English'],
      },
    };
    const topics: TopicLookup = {
      resolve: (ref: ChannelRef) =>
        channels[String(ref).toLowerCase()] ?? {
          kind: 'none',
          seen: ['General', 'Health', 'English'],
        },
    };
    const agentOf = (channel: string) =>
      snapshot(
        {
          'Agents/Health.md': '---\ntopics: [Health]\n---',
          'Workflows/Report.md': `---\nchannel: ${channel}\n---\nGo`,
        },
        { topics },
      ).workflows.get('report')!.agent;

    it('resolves the Agent through the Channel found', () => {
      expect(agentOf('Health')).toBe('health');
      expect(agentOf('7')).toBe('health');
      expect(agentOf('General')).toBe('main');
      expect(agentOf('8')).toBe('main');
    });

    it('gives the Channels found by ID, each once', () => {
      const result = snapshot(
        {
          'Agents/Health.md': '---\ntopics: [Health]\n---',
          'Workflows/Report.md':
            '---\nchannel: [Health, 8, General, 7, health]\nhistory: true\nhistory-channels: [8, Health]\n---\nGo',
          'Workflows/All.md': '---\nhistory: true\n---\nGo',
        },
        { topics },
      );
      expect(result.workflows.get('report')!.resolved).toEqual({
        targets: [3, 8, 1, 7],
        history: [8, 3],
      });
      expect(result.workflows.get('all')!.resolved).toEqual({
        targets: [],
        history: 'all',
      });
    });

    it('reports titles and IDs that match no topic, or several', () => {
      const files = {
        'Workflows/Report.md': `---
channel: [Helth, 99]
history: true
history-channels: English
---
Go`,
      };
      const result = snapshot(files, { topics });
      expect(result.workflows.size).toBe(0);
      expect(errorsOf(files, { topics })).toEqual([
        'Workflows/Report.md channel: no topic titled "Helth"; seen topics: General, Health, English',
        'Workflows/Report.md channel: no Channel has the ID 99',
        'Workflows/Report.md history-channels: "English" matches 2 topics: Home/English, Work/English; write <chat title>/<topic title>',
      ]);
    });
  });

  it('sorts errors by file', () => {
    expect(
      snapshot({
        'Workflows/B.md': '---\nhour: 30\n---\nGo',
        'Agents/A.md': '---\nmodle: x\n---',
        'Pero.md': '---\nprovidr: x\n---',
      }).errors.map((error) => error.file),
    ).toEqual(['Agents/A.md', 'Pero.md', 'Workflows/B.md']);
  });

  it('lists the properties Pero.md sets, leaving out empty ones', () => {
    const result = snapshot({
      'Pero.md':
        '---\nclaude-model: opus\ntimezone:\nprovider: codex\n---\nBe kind.',
    });
    expect([...result.peroProperties].sort()).toEqual([
      'claude-model',
      'provider',
    ]);
  });

  it('lists no Pero.md properties while it is broken', () => {
    const result = snapshot({ 'Pero.md': '---\nprovider: gemini\n---' });
    expect(result.peroProperties.size).toBe(0);
  });
});
