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
import { type SystemChange, SystemNotes } from './system-notes.service.js';
import { SystemModule } from './system.module.js';

describe('SystemNotes', () => {
  let tmp: string;
  let system: string;
  let moduleRef: TestingModule;
  let notes: SystemNotes;
  let health: ComponentHealth;
  /** Each write gets a later modification time, whatever the clock. */
  let clock: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-notes-'));
    system = join(tmp, 'data', 'System');
    mkdirSync(system, { recursive: true });
    clock = Date.parse('2026-01-01T00:00:00Z');
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Boots `module`, by default the system notes, in the workspace `tmp`. */
  async function boot(module: object = SystemModule) {
    const folders = {
      workspace: tmp,
      dataFolder: join(tmp, 'data'),
      systemFolder: system,
    };
    moduleRef = await Test.createTestingModule({
      imports: [module as typeof SystemModule],
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
    notes = moduleRef.get(SystemNotes);
    health = moduleRef.get(ComponentHealth);
  }

  function write(file: string, text: string) {
    const path = join(system, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
  }

  it('loads the notes at startup and reports them ok', async () => {
    write('Channels/Health.md', '---\nchannel-id: telegram:-1:5\n---\nCoach');
    await boot();
    expect(notes.snapshot()!.channelNotes.get('health')).toMatchObject({
      channelId: 'telegram:-1:5',
      workingDirectory: tmp,
    });
    expect(health.get('system')).toMatchObject({
      state: 'ok',
      detail: null,
      required: true,
    });
  });

  it('reports how many notes have errors', async () => {
    write('Channels/Coach.md', '---\nmodle: x\nefort: y\n---');
    write('Workflows/Report.md', '---\nhour: 99\n---\nGo');
    await boot();
    expect(health.get('system')).toMatchObject({
      state: 'degraded',
      detail: '2 notes have errors; run pero check',
    });
    expect(health.overall()).toBe('degraded');
  });

  it('takes in edits on a rescan and tells listeners', async () => {
    write('Channels/Health.md', 'Coach');
    await boot();
    const changes: SystemChange[] = [];
    notes.onChange((change) => changes.push(change));

    write('Channels/Health.md', '---\nmodel: opus\n---\nCoach');
    await notes.rescan();
    expect(notes.snapshot()!.channelNotes.get('health')!.model).toBe('opus');
    expect(changes).toEqual([
      { snapshot: notes.snapshot(), files: ['Channels/Health.md'] },
    ]);

    await notes.rescan();
    expect(changes).toHaveLength(1);
  });

  it('turns degraded when a note breaks, and ok when it is fixed', async () => {
    write('Channels/Health.md', '---\nmodel: opus\n---\nCoach');
    await boot();
    write('Channels/Health.md', '---\nmodel: opus\nmodle: x\n---\nCoach');
    await notes.rescan();
    expect(health.get('system')!.state).toBe('ok');
    await notes.rescan();
    expect(health.get('system')).toMatchObject({
      state: 'degraded',
      detail: '1 note has errors; run pero check',
    });
    expect(notes.snapshot()!.channelNotes.get('health')!.model).toBe('opus');

    write('Channels/Health.md', '---\nmodel: sonnet\n---\nCoach');
    await notes.rescan();
    expect(health.get('system')!.state).toBe('ok');
  });

  it('loads the notes before the startup of modules that read them', async () => {
    write('Channels/Health.md', 'Coach');

    @Injectable()
    class Reader implements OnModuleInit {
      agents: string[] = [];
      constructor(
        @Inject(Definitions) private readonly definitions: Definitions,
      ) {}
      onModuleInit(): void {
        this.agents = this.definitions.channelNotes().map((note) => note.name);
      }
    }
    @Module({ imports: [SystemModule], providers: [Reader] })
    class ReaderModule {}

    await boot(ReaderModule);
    expect(moduleRef.get(Reader).agents).toEqual(['health']);
  });
});
