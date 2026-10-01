import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  type SettingsSnapshot,
} from '../settings-files/snapshot.js';
import { channelTopicLookup } from './channel-topics.js';
import { Definitions } from './definitions.js';
import type { SettingsNotes } from './settings-notes.service.js';

const FOLDERS = {
  workspace: '/home/me/workspace',
  dataFolder: '/home/me/workspace/data',
  settingsFolder: '/home/me/workspace/data/Settings',
};

/** The Channels Pero has seen in the allowed chats. */
const TOPICS = channelTopicLookup([
  { id: 1, key: '-100777', title: 'Home' },
  { id: 2, key: '-100777:5', title: 'Health' },
  { id: 3, key: '-100777:6', title: 'English' },
  { id: 4, key: '1234', title: null },
]);

function snapshotOf(files: Record<string, string>): SettingsSnapshot {
  return buildSnapshot(
    Object.entries(files).map(([file, text]) => ({ file, text })),
    {
      workspace: FOLDERS.workspace,
      homeDir: '/home/me',
      hostTimeZone: 'UTC',
      topics: TOPICS,
    },
  );
}

/** `Definitions` over the notes `files`; `change` swaps them. */
function definitionsOf(files: Record<string, string> | null) {
  let snapshot = files === null ? null : snapshotOf(files);
  const notesListeners = new Set<() => void>();
  const notes = {
    snapshot: () => snapshot,
    folders: () => FOLDERS,
    onChange: (listener: () => void) => {
      notesListeners.add(listener);
      return () => notesListeners.delete(listener);
    },
  } as unknown as SettingsNotes;
  return {
    definitions: new Definitions(notes),
    change: (next: Record<string, string>) => {
      snapshot = snapshotOf(next);
      for (const listener of notesListeners) listener();
    },
  };
}

describe('Definitions', () => {
  it('reads the defaults from Pero.md and the data folder from config.yaml', () => {
    const { definitions } = definitionsOf({
      'Pero.md':
        '---\nprovider: codex\ncodex-model: gpt-5.5\nhistory-carryover: 10\nmax-concurrent-runs: 3\ntimezone: Europe/Berlin\n---\nBe brief.',
    });
    expect(definitions.defaults()).toEqual({
      provider: 'codex',
      providerDefaults: {
        claude: { model: null, effort: null },
        codex: { model: 'gpt-5.5', effort: null },
      },
      permissions: 'ask',
      timezone: 'Europe/Berlin',
      historyCarryover: 10,
      historyRetentionDays: null,
      maxConcurrentRuns: 3,
      dataFolder: FOLDERS.dataFolder,
      settingsFolder: FOLDERS.settingsFolder,
      guideFile: '/home/me/workspace/.pero/guide.md',
      sharedInstructions: 'Be brief.',
    });
  });

  it("uses Pero's own defaults while Pero.md is broken", () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\nprovider: gemini\n---\nBe brief.',
    });
    expect(definitions.defaults()).toMatchObject({
      provider: 'claude',
      sharedInstructions: null,
    });
  });

  it('gives each Agent its note with the defaults applied', () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\nclaude-model: opus\nclaude-effort: high\n---',
      'Agents/Health.md':
        '---\ntopics: Health\neffort: low\nworking-directory: projects/health\npermissions: bypass\n---\nCoach me.',
      'Agents/Home/Main.md': 'Help.',
    });
    expect(definitions.agent('HEALTH')).toMatchObject({
      name: 'health',
      title: 'Health',
      file: 'Agents/Health.md',
      topics: ['Health'],
      provider: 'claude',
      model: 'opus',
      effort: 'low',
      permissions: 'bypass',
      workingDirectory: '/home/me/workspace/projects/health',
      instructions: 'Coach me.',
      sharedInstructions: true,
      skipGitRepoCheck: false,
      enabled: true,
    });
    expect(definitions.agent('main')).toMatchObject({
      workingDirectory: FOLDERS.workspace,
      note: { workingDirectory: null },
    });
    expect(definitions.agent('coach')).toBeNull();
    expect(definitions.agents().map((agent) => agent.name)).toEqual([
      'health',
      'main',
    ]);
  });

  it('names the main Agent from Pero.md, even before its note exists', () => {
    const { definitions, change } = definitionsOf({
      'Pero.md': '---\nmain-agent: Coach\n---',
      'Agents/Main.md': 'Help.',
    });
    expect(definitions.mainAgent()).toBeNull();
    expect(definitions.mainAgentName()).toBe('coach');

    change({ 'Agents/Main.md': 'Help.' });
    expect(definitions.mainAgent()!.name).toBe('main');
    expect(definitions.mainAgentName()).toBe('main');
  });

  it('has no Agents before the notes could be read', () => {
    const { definitions } = definitionsOf(null);
    expect(definitions.agents()).toEqual([]);
    expect(definitions.mainAgentName()).toBe('main');
    expect(definitions.defaults().dataFolder).toBe(FOLDERS.dataFolder);
  });

  it('gives each Workflow its note with the Channels it names by ID', () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\ntimezone: Europe/Berlin\n---',
      'Agents/Health.md': '---\ntopics: Health\n---\nCoach me.',
      'Workflows/Weekly report.md':
        '---\nday: sunday\nhour: 12\nchannel: [Health, Home/General, 4]\nhistory: true\nhistory-channels: [English, Health]\nhistory-hours: 24\nmax-attempts: 2\n---\nWrite the weekly report.',
      'Workflows/Brief.md': '---\nhour: 9\nenabled: false\n---\nBrief me.',
    });
    expect(definitions.workflow('WEEKLY-REPORT')).toEqual({
      name: 'weekly-report',
      title: 'Weekly report',
      file: 'Workflows/Weekly report.md',
      agent: 'health',
      input: 'Write the weekly report.',
      channels: ['Health', 'Home/General', 4],
      history: {
        channels: ['English', 'Health'],
        messages: 'people',
        hours: 24,
        runWhenEmpty: false,
      },
      resolved: { targets: [2, 1, 4], history: [2, 3] },
      maxAttempts: 2,
      schedule: { cron: '0 12 * * 0', timezone: 'Europe/Berlin' },
      enabled: true,
    });
    expect(definitions.workflow('brief')).toMatchObject({
      agent: 'main',
      history: null,
      resolved: { targets: [], history: 'all' },
      schedule: { cron: '0 9 * * *', timezone: 'Europe/Berlin' },
      enabled: false,
    });
    expect(definitions.workflows().map((workflow) => workflow.name)).toEqual([
      'brief',
      'weekly-report',
    ]);
    expect(definitions.workflow('nope')).toBeNull();
  });

  it('leaves out a Workflow whose topic Pero has not seen', () => {
    const { definitions } = definitionsOf({
      'Workflows/Report.md': '---\nchannel: Helth\n---\nReport.',
    });
    expect(definitions.workflow('report')).toBeNull();
    expect(definitions.workflows()).toEqual([]);
  });

  it('tells listeners of changed notes', () => {
    const { definitions, change } = definitionsOf({});
    const listener = vi.fn();
    const stop = definitions.onChange(listener);
    change({ 'Agents/Main.md': 'Hi' });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    change({});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
