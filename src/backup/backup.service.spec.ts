import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import Database from 'better-sqlite3';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { ConflictError, InvalidInputError } from '../common/errors.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import { type DataDirLayout, ensureDataDir } from '../config/data-dir.js';
import { writeSecret } from '../config/secret-store.js';
import { HostConfigModule } from '../host-config/host-config.module.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { MIGRATIONS } from '../persistence/migrations/index.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TestWorkspace } from '../settings-notes/testing/test-workspace.js';
import { DATABASE_ENTRY, extractBackupArchive } from './archive.js';
import { BackupModule } from './backup.module.js';
import { BackupService } from './backup.service.js';

describe('BackupService', () => {
  let tmp: string;
  let layout: DataDirLayout;
  let vault: string;
  let own: string;
  let moduleRef: TestingModule;
  let backups: BackupService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-backup-'));
    layout = ensureDataDir(join(tmp, 'pero'));
    vault = join(tmp, 'vault');
    own = join(tmp, 'own');
    mkdirSync(vault);
    mkdirSync(own);
    await boot();
  });

  /** Starts the backup service on the data directory, with `config`. */
  async function boot(config?: string) {
    if (config !== undefined) writeFileSync(layout.configFile, config);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: layout.database }),
        HostConfigModule.forRoot({
          file: layout.configFile,
          workspace: null,
          base: layout.root,
        }),
        AgentsModule,
        BackupModule.forRoot({ layout }),
      ],
    }).compile();
    await moduleRef.init();
    backups = moduleRef.get(BackupService);
  }

  /** Starts over with `config.yaml` naming `folder` as the data folder. */
  async function withDataFolder(folder: string) {
    await moduleRef.close();
    await boot(`data: ${folder}\n`);
  }

  afterEach(async () => {
    await moduleRef.close();
    chmodSync(tmp, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  });

  async function extract(file: string) {
    const dir = join(tmp, 'extracted');
    mkdirSync(dir);
    return { dir, manifest: await extractBackupArchive(file, dir) };
  }

  it('snapshots committed work still in the WAL, with config.yaml, the secrets, and a manifest', async () => {
    await withDataFolder(vault);
    const ds = moduleRef.get<DataSource>(getDataSourceToken());
    await ds.getRepository(Channel).save({
      integrationKind: 'telegram',
      externalKey: '1234',
      address: { chatId: '1234' },
      title: 'Ada',
    });
    writeSecret(layout.secrets, 'telegram-bot-token', 'secret-token');
    writeFileSync(layout.configFile, '# mine\ndata: /srv/vault\n');
    // Not checkpointed: a copy of pero.sqlite alone would miss these rows.
    expect(statSync(`${layout.database}-wal`).size).toBeGreaterThan(0);
    const file = join(tmp, 'backup.tgz');

    const result = await backups.create(file);

    expect(result).toEqual({
      file,
      createdAt: expect.any(String),
      bytes: statSync(file).size,
      includesSecrets: true,
      includesData: false,
    });
    const { dir, manifest } = await extract(file);
    expect(manifest).toEqual({
      format: 2,
      peroVersion: PACKAGE_VERSION,
      createdAt: result.createdAt,
      sourceDataDir: layout.root,
      sourceWorkspace: null,
      lastMigration: MIGRATIONS.at(-1)!.name,
      // A legacy data directory has no Agents, so no folders of their own.
      workingDirectories: [{ path: vault, agent: null }],
      secrets: ['telegram-bot-token'],
    });
    expect(readdirSync(dir).sort()).toEqual([
      'config.yaml',
      'pero-backup.json',
      'pero.sqlite',
      'secrets',
    ]);
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(
      '# mine\ndata: /srv/vault\n',
    );

    const snapshot = new Database(join(dir, DATABASE_ENTRY), {
      readonly: true,
    });
    try {
      expect(snapshot.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(snapshot.prepare('SELECT "title" FROM "channels"').all()).toEqual([
        { title: 'Ada' },
      ]);
    } finally {
      snapshot.close();
    }
  });

  it('records no folders or secrets on a fresh installation', async () => {
    const file = join(tmp, 'backup.tgz');

    const result = await backups.create(file);

    expect(result.includesSecrets).toBe(false);
    const { dir, manifest } = await extract(file);
    expect(manifest).toMatchObject({ workingDirectories: [], secrets: [] });
    // Pero writes config.yaml as it starts.
    expect(readdirSync(dir).sort()).toEqual([
      'config.yaml',
      'pero-backup.json',
      'pero.sqlite',
    ]);
  });

  it('includes the data folder when asked, without links or the state directory', async () => {
    await withDataFolder(vault);
    mkdirSync(join(vault, 'Settings'));
    writeFileSync(join(vault, 'Settings', 'Pero.md'), 'Be brief.\n');
    symlinkSync('/etc', join(vault, 'etc'));
    const file = join(tmp, 'backup.tgz');

    await expect(backups.create(file)).resolves.toMatchObject({
      includesData: false,
    });
    expect((await extract(file)).manifest.format).toBe(2);
    rmSync(join(tmp, 'extracted'), { recursive: true });

    const result = await backups.create(file, { includeData: true });

    expect(result).toMatchObject({ includesData: true });
    const { dir, manifest } = await extract(file);
    expect(manifest).toMatchObject({ format: 3, includesData: true });
    expect(readdirSync(join(dir, 'data'))).toEqual(['Settings']);
    expect(readFileSync(join(dir, 'data', 'Settings', 'Pero.md'), 'utf8')).toBe(
      'Be brief.\n',
    );
    expect(readdirSync(tmp).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('leaves out the state directory and .env of a workspace inside its data folder', async () => {
    const ws = TestWorkspace.create('pero-backup-ws-');
    try {
      await moduleRef.close();
      writeFileSync(join(ws.stateFolder, 'config.yaml'), 'data: .\n');
      writeFileSync(join(ws.root, '.env'), 'PERO_TELEGRAM_BOT_TOKEN=x\n');
      writeFileSync(join(ws.root, 'note.md'), 'Hi');
      const workspaceLayout = ensureDataDir(ws.stateFolder, ws.root);
      moduleRef = await Test.createTestingModule({
        imports: [
          PersistenceModule.forRoot({ database: workspaceLayout.database }),
          ws.hostConfig(),
          AgentsModule,
          BackupModule.forRoot({ layout: workspaceLayout }),
        ],
      }).compile();
      await moduleRef.init();
      const file = join(tmp, 'backup.tgz');

      await moduleRef.get(BackupService).create(file, { includeData: true });

      const { dir, manifest } = await extract(file);
      expect(readdirSync(join(dir, 'data')).sort()).toEqual([
        'data',
        'note.md',
      ]);
      expect(manifest.workingDirectories).toEqual([
        { path: ws.root, agent: null },
      ]);
    } finally {
      ws.delete();
    }
  });

  it("records a workspace's data folder and its Agents' own folders", async () => {
    const ws = TestWorkspace.create('pero-backup-ws-');
    try {
      await ws.agent('Coder', { 'working-directory': own });
      await ws.agent('Notes');
      await moduleRef.close();
      const workspaceLayout = ensureDataDir(ws.stateFolder, ws.root);
      moduleRef = await Test.createTestingModule({
        imports: [
          PersistenceModule.forRoot({ database: workspaceLayout.database }),
          ws.hostConfig(),
          AgentsModule,
          BackupModule.forRoot({ layout: workspaceLayout }),
        ],
      }).compile();
      await moduleRef.init();
      const file = join(tmp, 'backup.tgz');

      await moduleRef.get(BackupService).create(file);

      expect((await extract(file)).manifest.workingDirectories).toEqual([
        { path: ws.dataFolder, agent: null },
        { path: own, agent: 'coder' },
      ]);
    } finally {
      ws.delete();
    }
  });

  it('refuses to include data it has not got, or into itself', async () => {
    await expect(
      backups.create(join(tmp, 'backup.tgz'), { includeData: true }),
    ).rejects.toThrow(/no data folder to include/);

    await withDataFolder(vault);
    const result = backups.create(join(vault, 'backup.tgz'), {
      includeData: true,
    });
    await expect(result).rejects.toThrow(InvalidInputError);
    await expect(result).rejects.toThrow(
      `must be outside the data folder ${vault} it includes`,
    );
  });

  it('rejects a destination it should not write', async () => {
    const cases: [string, RegExp][] = [
      ['backup.tgz', /must be an absolute path/],
      [join(layout.root, 'backup.tgz'), /must be outside the data directory/],
      [layout.root, /must be outside the data directory/],
      [join(tmp, 'missing', 'backup.tgz'), /does not exist/],
      [vault, /is a folder/],
    ];
    for (const [file, message] of cases) {
      const result = backups.create(file);
      await expect(result).rejects.toThrow(InvalidInputError);
      await expect(result).rejects.toThrow(message);
    }
  });

  it('writes one backup at a time', async () => {
    const first = backups.create(join(tmp, 'first.tgz'));

    await expect(backups.create(join(tmp, 'second.tgz'))).rejects.toThrow(
      ConflictError,
    );
    await first;
    await expect(
      backups.create(join(tmp, 'second.tgz')),
    ).resolves.toMatchObject({ file: join(tmp, 'second.tgz') });
  });

  it('finishes a backup in progress before the database closes', async () => {
    const file = join(tmp, 'backup.tgz');
    const backup = backups.create(file);

    await moduleRef.close();

    await expect(backup).resolves.toMatchObject({ file });
    expect(existsSync(file)).toBe(true);
    // Reopened so afterEach can close it again.
    moduleRef = await Test.createTestingModule({}).compile();
  });
});
