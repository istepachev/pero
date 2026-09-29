import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComponentHealth } from '../health/component-health.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import type { SettingsChange } from './settings-notes.service.js';
import { SettingsNotes } from './settings-notes.service.js';
import { SettingsNotesModule } from './settings-notes.module.js';

describe('SettingsNotes', () => {
  let tmp: string;
  let settings: string;
  let moduleRef: TestingModule;
  let notes: SettingsNotes;
  let health: ComponentHealth;
  /** Each write gets a later modification time, whatever the clock. */
  let clock: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-notes-'));
    settings = join(tmp, 'data', 'Settings');
    mkdirSync(settings, { recursive: true });
    clock = Date.parse('2026-01-01T00:00:00Z');
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Boots the module in a workspace, or in a legacy data directory. */
  async function boot(workspace = true) {
    const folders = workspace
      ? {
          workspace: tmp,
          dataFolder: join(tmp, 'data'),
          settingsFolder: settings,
        }
      : null;
    moduleRef = await Test.createTestingModule({
      imports: [SettingsNotesModule],
    })
      .useMocker((token) => {
        if (token === HostConfigService) return { folders: () => folders };
        // The database, which only `pero check` reads.
        return {};
      })
      .compile();
    await moduleRef.init();
    notes = moduleRef.get(SettingsNotes);
    health = moduleRef.get(ComponentHealth);
  }

  function write(file: string, text: string) {
    const path = join(settings, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
  }

  it('loads the notes at startup and reports them ok', async () => {
    write('Agents/Health.md', '---\ntopics: Health\n---\nCoach');
    await boot();
    expect(notes.snapshot()!.agents.get('health')).toMatchObject({
      topics: ['Health'],
      workingDirectory: join(tmp, 'data'),
    });
    expect(health.get('settings')).toMatchObject({
      state: 'ok',
      detail: null,
      required: true,
    });
  });

  it('reports how many notes have errors', async () => {
    write('Agents/Coach.md', '---\nmodle: x\nefort: y\n---');
    write('Workflows/Report.md', '---\nhour: 99\n---\nGo');
    await boot();
    expect(health.get('settings')).toMatchObject({
      state: 'degraded',
      detail: '2 notes have errors; run pero check',
    });
    expect(health.overall()).toBe('degraded');
  });

  it('takes in edits on a rescan and tells listeners', async () => {
    write('Agents/Health.md', 'Coach');
    await boot();
    const changes: SettingsChange[] = [];
    notes.onChange((change) => changes.push(change));

    write('Agents/Health.md', '---\nmodel: opus\n---\nCoach');
    await notes.rescan();
    expect(notes.snapshot()!.agents.get('health')!.model).toBe('opus');
    expect(changes).toEqual([
      { snapshot: notes.snapshot(), files: ['Agents/Health.md'] },
    ]);

    await notes.rescan();
    expect(changes).toHaveLength(1);
  });

  it('turns degraded when a note breaks, and ok when it is fixed', async () => {
    write('Agents/Health.md', '---\nmodel: opus\n---\nCoach');
    await boot();
    write('Agents/Health.md', '---\nmodel: opus\nmodle: x\n---\nCoach');
    await notes.rescan();
    expect(health.get('settings')!.state).toBe('ok');
    await notes.rescan();
    expect(health.get('settings')).toMatchObject({
      state: 'degraded',
      detail: '1 note has errors; run pero check',
    });
    expect(notes.snapshot()!.agents.get('health')!.model).toBe('opus');

    write('Agents/Health.md', '---\nmodel: sonnet\n---\nCoach');
    await notes.rescan();
    expect(health.get('settings')!.state).toBe('ok');
  });

  it('does nothing in a legacy data directory', async () => {
    write('Agents/Health.md', 'Coach');
    await boot(false);
    expect(notes.snapshot()).toBeNull();
    await notes.rescan();
    expect(health.get('settings')).toBeUndefined();
  });
});
