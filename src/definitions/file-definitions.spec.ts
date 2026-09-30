import { describe, expect, it, vi } from 'vitest';
import type { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import {
  buildSnapshot,
  type SettingsSnapshot,
} from '../settings-files/snapshot.js';
import type { WorkflowDefinition } from './definitions.js';
import { FileDefinitions } from './file-definitions.js';
import type { SqliteDefinitions } from './sqlite-definitions.js';

const FOLDERS = {
  workspace: '/home/me/workspace',
  dataFolder: '/home/me/workspace/data',
  settingsFolder: '/home/me/workspace/data/Settings',
};

function snapshotOf(files: Record<string, string>): SettingsSnapshot {
  return buildSnapshot(
    Object.entries(files).map(([file, text]) => ({ file, text })),
    {
      workspace: FOLDERS.workspace,
      dataFolder: FOLDERS.dataFolder,
      homeDir: '/home/me',
      hostTimeZone: 'UTC',
    },
  );
}

const REPORT: WorkflowDefinition = {
  name: 'report',
  title: null,
  agent: 'health',
  input: 'Report.',
  history: null,
  targets: [],
  maxAttempts: 1,
  schedules: [],
  enabled: true,
};

/** `FileDefinitions` over the notes `files`; `change` swaps them. */
function definitionsOf(files: Record<string, string> | null) {
  let snapshot = files === null ? null : snapshotOf(files);
  const notesListeners = new Set<() => void>();
  const sqliteListeners = new Set<() => void>();
  const ready = vi.fn(() => Promise.resolve(snapshot));
  const notes = {
    ready,
    folders: () => FOLDERS,
    onChange: (listener: () => void) => {
      notesListeners.add(listener);
      return () => notesListeners.delete(listener);
    },
  } as unknown as SettingsNotes;
  const sqlite = {
    workflow: (name: string) =>
      Promise.resolve(name === 'report' ? REPORT : null),
    workflows: () => Promise.resolve([REPORT]),
    onChange: (listener: () => void) => {
      sqliteListeners.add(listener);
      return () => sqliteListeners.delete(listener);
    },
  } as unknown as SqliteDefinitions;
  return {
    definitions: new FileDefinitions(notes, sqlite),
    ready,
    change: (next: Record<string, string>) => {
      snapshot = snapshotOf(next);
      for (const listener of notesListeners) listener();
    },
    sqliteChanged: () => {
      for (const listener of sqliteListeners) listener();
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

  it('takes Workflows from SQLite', async () => {
    const { definitions } = definitionsOf({});
    expect(await definitions.workflow('report')).toBe(REPORT);
    expect(await definitions.workflows()).toEqual([REPORT]);
  });

  it('tells listeners of changed notes and changed Workflows', async () => {
    const { definitions, change, sqliteChanged } = definitionsOf({});
    const listener = vi.fn();
    const stop = definitions.onChange(listener);
    change({ 'Agents/Main.md': 'Hi' });
    sqliteChanged();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    change({});
    sqliteChanged();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
