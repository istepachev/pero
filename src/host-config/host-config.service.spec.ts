import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../config/bootstrap-config.js';
import { ComponentHealth } from '../health/component-health.js';
import { AllowedChat } from '../persistence/entities/allowed-chat.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { HostConfigModule } from './host-config.module.js';
import {
  type AllowedChatsChange,
  HostConfigService,
} from './host-config.service.js';

describe('HostConfigService', () => {
  let tmp: string;
  let database: string;
  let workspace: string;
  let file: string;
  let moduleRef: TestingModule | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-host-')));
    database = join(tmp, 'pero.sqlite');
    workspace = join(tmp, 'ws');
    file = join(workspace, '.pero', 'config.yaml');
    mkdirSync(join(workspace, '.pero'), { recursive: true });
  });

  afterEach(async () => {
    // A module whose startup failed throws that failure again on close.
    await moduleRef?.close().catch(() => undefined);
    moduleRef = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Opens the database without the service, to arrange rows first. */
  async function withDatabase(
    arrange: (dataSource: DataSource) => Promise<unknown>,
  ): Promise<void> {
    const ref = await Test.createTestingModule({
      imports: [PersistenceModule.forRoot({ database })],
    }).compile();
    await ref.init();
    await arrange(ref.get<DataSource>(getDataSourceToken()));
    await ref.close();
  }

  async function start(
    options: { legacy?: boolean } = {},
  ): Promise<HostConfigService> {
    const legacyDir = join(tmp, 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database }),
        HostConfigModule.forRoot(
          options.legacy
            ? {
                file: join(legacyDir, 'config.yaml'),
                workspace: null,
                base: legacyDir,
              }
            : { file, workspace, base: workspace },
        ),
      ],
    }).compile();
    await moduleRef.init();
    return moduleRef.get(HostConfigService);
  }

  /** The data folder the running Pero uses. */
  const dataFolder = () => moduleRef!.get(HostConfigService).dataFolder();

  /** Sets the default working directory a legacy installation kept. */
  const setLegacyFolder = (dataSource: DataSource, folder: string) =>
    dataSource.query(
      `UPDATE "legacy_settings" SET "default_working_directory" = ?`,
      [folder],
    );

  it('creates config.yaml with the data folder once, in a new workspace', async () => {
    await start();

    expect(readFileSync(file, 'utf8')).toContain('\ndata: data\n');
    expect(existsSync(join(workspace, 'data'))).toBe(true);
    expect(dataFolder()).toBe(join(workspace, 'data'));

    await moduleRef!.close();
    writeFileSync(file, `${readFileSync(file, 'utf8')}# kept\n`);
    await start();
    expect(readFileSync(file, 'utf8')).toMatch(/# kept\n$/);
  });

  it('carries the default working directory and allowed chats over once', async () => {
    const vault = join(workspace, 'vault');
    mkdirSync(vault);
    await withDatabase(async (dataSource) => {
      await setLegacyFolder(dataSource, vault);
      await dataSource.getRepository(AllowedChat).insert([
        {
          integrationKind: 'telegram',
          chatKey: '-1009007199254740993',
          kind: 'group',
          title: 'Home',
        },
        {
          integrationKind: 'telegram',
          chatKey: '123456789',
          kind: 'private',
          title: null,
        },
      ]);
    });

    const service = await start();

    expect(service.allowedChats()).toEqual([
      { chatKey: '-1009007199254740993', title: 'Home' },
      { chatKey: '123456789', title: null },
    ]);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('\ndata: vault\n');
    expect(text).toContain(
      '    - id: -1009007199254740993\n      title: Home\n    - id: 123456789\n',
    );
    const dataSource = moduleRef!.get<DataSource>(getDataSourceToken());
    expect(await dataSource.getRepository(AllowedChat).count()).toBe(0);
    expect(dataFolder()).toBe(vault);

    // Denied by hand, it stays denied on the next start.
    await moduleRef!.close();
    writeFileSync(file, text.replace(/ {4}- id: 123456789\n/, ''));
    expect((await start()).allowedChats()).toHaveLength(1);
  });

  it('adds rows found later, such as from a restored database, to the file', async () => {
    await start();
    await moduleRef!.close();
    await withDatabase((dataSource) =>
      dataSource.getRepository(AllowedChat).insert({
        integrationKind: 'telegram',
        chatKey: '42',
        kind: 'private',
        title: null,
      }),
    );

    const service = await start();

    expect(service.allowedChats()).toEqual([{ chatKey: '42', title: null }]);
  });

  it('serves the data folder config.yaml names', async () => {
    mkdirSync(join(tmp, 'notes'));
    writeFileSync(file, `data: ${join(tmp, 'notes')}\n`);

    const service = await start();

    expect(dataFolder()).toBe(join(tmp, 'notes'));
    expect(service.folders()).toEqual({
      workspace,
      dataFolder: join(tmp, 'notes'),
      settingsFolder: join(tmp, 'notes', 'Settings'),
    });
  });

  it('stops startup when a data folder it names is missing', async () => {
    writeFileSync(file, 'data: missing\n');

    const error = await start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      `Invalid ${file}:\n  data: Working directory ${join(workspace, 'missing')} does not exist`,
    );
  });

  it('stops startup on an invalid file, naming the key', async () => {
    writeFileSync(file, 'telegram:\n  allowed-chats: 5\n');

    const error = await start().catch((caught: unknown) => caught);
    expect((error as Error).message).toContain(
      'line 2: telegram.allowed-chats: must be a list of chats, each with an id',
    );
  });

  it('writes its changes to the file and keeps them in memory', async () => {
    const service = await start();

    expect(service.allow('-100555', 'Family')).toBe(true);
    expect(service.allow('-100555', null)).toBe(false);
    expect(service.moveChat('-100555', '-100777')).toBe(true);
    expect(service.allow('12', null)).toBe(true);
    expect(service.deny('12')).toBe(true);
    expect(service.deny('12')).toBe(false);

    expect(service.allowedChats()).toEqual([
      { chatKey: '-100777', title: 'Family' },
    ]);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('\ndata: data\n');
    expect(text).toContain('    - id: -100777\n      title: Family\n');
  });

  describe('edits by hand', () => {
    let edits = 0;

    /**
     * Writes `text` so that its modification time surely changes: each edit
     * is a second later than the last, even when two land in the same
     * millisecond with the same size.
     */
    function edit(text: string) {
      writeFileSync(file, text);
      edits += 1;
      const later = new Date(Date.now() + 5_000 + edits * 1_000);
      utimesSync(file, later, later);
    }

    const component = () => moduleRef!.get(ComponentHealth).get('config');

    it('serves chats added or removed by hand from the next look, and says which', async () => {
      const service = await start();
      service.allow('-100111', 'Family');
      const changes: AllowedChatsChange[] = [];
      service.onChatsChange((change) => changes.push(change));

      // Pero's own write is not news on the next look.
      service.reload();
      expect(changes).toEqual([]);

      edit(
        readFileSync(file, 'utf8').replace(
          '    - id: -100111\n      title: Family\n',
          '    - id: 42 # me\n',
        ),
      );
      service.reload();
      service.reload();

      expect(service.allowedChats()).toEqual([{ chatKey: '42', title: null }]);
      expect(changes).toEqual([{ added: ['42'], removed: ['-100111'] }]);
      expect(component()).toMatchObject({ state: 'ok' });
    });

    it('keeps the last valid version of a broken edit, reporting it once', async () => {
      const service = await start();
      service.allow('42', null);
      const errors = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      edit('data: data\ntelegram:\n  allowed-chats:\n    - id: me\n');
      service.reload();
      edit('data: data\ntelegram:\n  allowed-chats:\n    - id: me\n');
      service.reload();

      expect(service.allowedChats()).toEqual([{ chatKey: '42', title: null }]);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]![0]).toContain(
        'line 4: telegram.allowed-chats (item 1).id: must be a Telegram chat ID',
      );
      expect(component()).toMatchObject({
        state: 'degraded',
        detail: expect.stringMatching(
          /^Invalid .*config\.yaml: line 4: telegram\.allowed-chats \(item 1\)\.id: .*; the last valid version stays in use$/,
        ),
      });

      edit('data: data\ntelegram:\n  allowed-chats:\n    - id: 43\n');
      service.reload();
      expect(service.allowedChats()).toEqual([{ chatKey: '43', title: null }]);
      expect(component()).toMatchObject({ state: 'ok' });
      errors.mockRestore();
    });

    it('says a changed data folder waits for a restart, and keeps the old one', async () => {
      const service = await start();

      edit(readFileSync(file, 'utf8').replace('data: data', 'data: notes'));
      service.reload();
      expect(component()).toMatchObject({
        state: 'degraded',
        detail: `data changed in ${file}; restart Pero to apply`,
      });
      expect(dataFolder()).toBe(join(workspace, 'data'));

      edit(readFileSync(file, 'utf8').replace('data: notes', 'data: data'));
      service.reload();
      expect(component()).toMatchObject({ state: 'ok' });
    });

    it('reports a deleted file and keeps serving the last version', async () => {
      const service = await start();
      service.allow('42', null);
      const errors = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      rmSync(file);
      service.reload();

      expect(service.allowedChats()).toHaveLength(1);
      expect(component()).toMatchObject({
        state: 'degraded',
        detail: `${file} is missing; the last valid version stays in use`,
      });
      errors.mockRestore();
    });
  });

  describe('in a legacy data directory', () => {
    it('leaves data unset without a default working directory', async () => {
      await start({ legacy: true });

      const text = readFileSync(join(tmp, 'legacy', 'config.yaml'), 'utf8');
      expect(text).toContain('\n# data: data\n');
      expect(dataFolder()).toBeNull();
      expect(moduleRef!.get(HostConfigService).folders()).toBeNull();
    });

    it('writes the default working directory as an absolute path, and only warns when it is gone', async () => {
      const vault = join(tmp, 'vault');
      await withDatabase((dataSource) => setLegacyFolder(dataSource, vault));

      await start({ legacy: true });

      const text = readFileSync(join(tmp, 'legacy', 'config.yaml'), 'utf8');
      expect(text).toContain(`\ndata: ${vault}\n`);
      expect(dataFolder()).toBe(vault);
    });
  });
});
