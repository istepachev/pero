import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComponentHealth } from '../health/component-health.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { Definitions } from './definitions.js';
import {
  type SettingsChange,
  SettingsNotes,
} from './settings-notes.service.js';
import { SettingsModule } from './settings.module.js';

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

  /** Boots `module`, by default the settings, in the workspace `tmp`. */
  async function boot(module: object = SettingsModule) {
    const folders = {
      workspace: tmp,
      dataFolder: join(tmp, 'data'),
      settingsFolder: settings,
    };
    moduleRef = await Test.createTestingModule({
      imports: [module as typeof SettingsModule],
    })
      .useMocker((token) => {
        if (token === HostConfigService) {
          return {
            folders: () => folders,
            allowedChats: () => [],
          };
        }
        // No Channel seen yet.
        if (token === DataSource) {
          return { getRepository: () => ({ find: () => Promise.resolve([]) }) };
        }
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

  it('loads the notes before the startup of modules that read them', async () => {
    write('Agents/Health.md', 'Coach');

    @Injectable()
    class Reader implements OnModuleInit {
      agents: string[] = [];
      constructor(
        @Inject(Definitions) private readonly definitions: Definitions,
      ) {}
      onModuleInit(): void {
        this.agents = this.definitions.agents().map((agent) => agent.name);
      }
    }
    @Module({ imports: [SettingsModule], providers: [Reader] })
    class ReaderModule {}

    await boot(ReaderModule);
    expect(moduleRef.get(Reader).agents).toEqual(['health']);
  });
});
