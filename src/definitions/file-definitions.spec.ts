import { describe, expect, it, vi } from 'vitest';
import { channelTopicLookup } from '../settings-notes/channel-topics.js';
import type { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import {
  buildSnapshot,
  type SettingsSnapshot,
} from '../settings-files/snapshot.js';
import { FileDefinitions } from './file-definitions.js';

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
      dataFolder: FOLDERS.dataFolder,
      homeDir: '/home/me',
      hostTimeZone: 'UTC',
      topics: TOPICS,
    },
  );
}

/** `FileDefinitions` over the notes `files`; `change` swaps them. */
function definitionsOf(files: Record<string, string> | null) {
  let snapshot = files === null ? null : snapshotOf(files);
  const notesListeners = new Set<() => void>();
  const ready = vi.fn(() => Promise.resolve(snapshot));
  const notes = {
    ready,
    folders: () => FOLDERS,
    onChange: (listener: () => void) => {
      notesListeners.add(listener);
      return () => notesListeners.delete(listener);
    },
  } as unknown as SettingsNotes;
  return {
    definitions: new FileDefinitions(notes),
    ready,
    change: (next: Record<string, string>) => {
      snapshot = snapshotOf(next);
      for (const listener of notesListeners) listener();
    },
  };
}

describe('FileDefinitions', () => {
  it('reads the defaults from Pero.md and the data folder from config.yaml', async () => {
    const { definitions } = definitionsOf({
      'Pero.md':
        '---\nprovider: codex\ncodex-model: gpt-5.5\nhistory-carryover: 10\nmax-concurrent-runs: 3\ntimezone: Europe/Berlin\n---\nBe brief.',
    });
    expect(await definitions.defaults()).toEqual({
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
      sharedInstructions: 'Be brief.',
    });
  });

  it("uses Pero's own defaults while Pero.md is broken", async () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\nprovider: gemini\n---\nBe brief.',
    });
    expect(await definitions.defaults()).toMatchObject({
      provider: 'claude',
      sharedInstructions: null,
    });
  });

  it('gives each Agent its note with the defaults applied', async () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\nclaude-model: opus\nclaude-effort: high\n---',
      'Agents/Health.md':
        '---\ntopics: Health\neffort: low\nworking-directory: projects/health\npermissions: bypass\n---\nCoach me.',
      'Agents/Home/Main.md': 'Help.',
    });
    expect(await definitions.agent('HEALTH')).toEqual({
      name: 'health',
      title: 'Health',
      provider: 'claude',
      providerOptions: { model: 'opus', effort: 'low' },
      permissions: 'bypass',
      workingDirectory: '/home/me/workspace/projects/health',
      ownWorkingDirectory: '/home/me/workspace/projects/health',
      instructions: 'Coach me.',
      sharedInstructions: true,
      skipGitRepoCheck: false,
      enabled: true,
    });
    expect(await definitions.agent('main')).toMatchObject({
      workingDirectory: FOLDERS.dataFolder,
      ownWorkingDirectory: null,
    });
    expect(await definitions.agent('coach')).toBeNull();
    expect((await definitions.agents()).map((agent) => agent.name)).toEqual([
      'health',
      'main',
    ]);
  });

  it('names the main Agent from Pero.md, even before its note exists', async () => {
    const { definitions, change } = definitionsOf({
      'Pero.md': '---\nmain-agent: Coach\n---',
      'Agents/Main.md': 'Help.',
    });
    expect(await definitions.mainAgent()).toBeNull();
    expect(await definitions.mainAgentName()).toBe('coach');

    change({ 'Agents/Main.md': 'Help.' });
    expect((await definitions.mainAgent())!.name).toBe('main');
    expect(await definitions.mainAgentName()).toBe('main');
  });

  it('has no Agents before the notes could be read', async () => {
    const { definitions } = definitionsOf(null);
    expect(await definitions.agents()).toEqual([]);
    expect(await definitions.mainAgentName()).toBe('main');
    expect((await definitions.defaults()).dataFolder).toBe(FOLDERS.dataFolder);
  });

  it('waits for the notes to load', async () => {
    const { definitions, ready } = definitionsOf({ 'Agents/Main.md': 'Hi' });
    await definitions.agent('main');
    expect(ready).toHaveBeenCalled();
  });

  it('gives each Workflow its note with the Channels it names by ID', async () => {
    const { definitions } = definitionsOf({
      'Pero.md': '---\ntimezone: Europe/Berlin\n---',
      'Agents/Health.md': '---\ntopics: Health\n---\nCoach me.',
      'Workflows/Weekly report.md':
        '---\nday: sunday\nhour: 12\nchannel: [Health, Home/General, 4]\nhistory: true\nhistory-channels: [English, Health]\nhistory-hours: 24\nmax-attempts: 2\n---\nWrite the weekly report.',
      'Workflows/Brief.md':
        '---\ntrigger: manual\nhour: 9\nenabled: false\n---\nBrief me.',
    });
    expect(await definitions.workflow('WEEKLY-REPORT')).toEqual({
      name: 'weekly-report',
      title: 'Weekly report',
      agent: 'health',
      input: 'Write the weekly report.',
      history: {
        channels: [2, 3],
        messages: 'people',
        hours: 24,
        runWhenEmpty: false,
      },
      targets: [2, 1, 4],
      maxAttempts: 2,
      schedules: [{ cron: '0 12 * * 0', timezone: 'Europe/Berlin' }],
      enabled: true,
    });
    expect(await definitions.workflow('brief')).toMatchObject({
      agent: 'main',
      history: null,
      targets: [],
      schedules: [],
      enabled: false,
    });
    expect(
      (await definitions.workflows()).map((workflow) => workflow.name),
    ).toEqual(['brief', 'weekly-report']);
    expect(await definitions.workflow('nope')).toBeNull();
  });

  it('leaves out a Workflow whose topic Pero has not seen', async () => {
    const { definitions } = definitionsOf({
      'Workflows/Report.md': '---\nchannel: Helth\n---\nReport.',
    });
    expect(await definitions.workflow('report')).toBeNull();
    expect(await definitions.workflows()).toEqual([]);
  });

  it('tells listeners of changed notes', async () => {
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
