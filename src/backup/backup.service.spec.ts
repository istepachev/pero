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
import {
  type WorkspaceLayout,
  ensureWorkspaceLayout,
} from '../config/workspace-layout.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { MIGRATIONS } from '../persistence/migrations/index.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import { DATABASE_ENTRY, extractBackupArchive } from './archive.js';
import { BackupModule } from './backup.module.js';
import { BackupService } from './backup.service.js';

describe('BackupService', () => {
  let tmp: string;
  let ws: TestWorkspace;
  let layout: WorkspaceLayout;
  let vault: string;
  let own: string;
  let moduleRef: TestingModule;
  let backups: BackupService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-backup-'));
    ws = TestWorkspace.create('pero-backup-ws-');
    layout = ensureWorkspaceLayout(ws.root);
    vault = join(tmp, 'vault');
    own = join(tmp, 'own');
    mkdirSync(vault);
    mkdirSync(own);
    await boot();
  });

  /** Starts the backup service on the workspace, with `config`. */
  async function boot(config?: string) {
    if (config !== undefined) writeFileSync(layout.configFile, config);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: layout.database }),
        ws.hostConfig(),
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
    ws.delete();
    chmodSync(tmp, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  });

  async function extract(file: string) {
    const dir = join(tmp, 'extracted');
    mkdirSync(dir);
    return { dir, manifest: await extractBackupArchive(file, dir) };
  }

  it('snapshots committed work still in the WAL, with config.yaml and a manifest', async () => {
    await withDataFolder(vault);
    const ds = moduleRef.get<DataSource>(getDataSourceToken());
    await ds.getRepository(Channel).save({
      integrationKind: 'telegram',
      externalKey: '1234',
      address: { chatId: '1234' },
      title: 'Ada',
    });
    writeFileSync(layout.configFile, '# mine\ndata: /srv/vault\n');
    // Not checkpointed: a copy of pero.sqlite alone would miss these rows.
    expect(statSync(`${layout.database}-wal`).size).toBeGreaterThan(0);
    const file = join(tmp, 'backup.tgz');

    const result = await backups.create(file);

    expect(result).toEqual({
      file,
      createdAt: expect.any(String),
      bytes: statSync(file).size,
      includesData: false,
    });
    const { dir, manifest } = await extract(file);
    expect(manifest).toEqual({
      format: 1,
      peroVersion: PACKAGE_VERSION,
      createdAt: result.createdAt,
      sourceWorkspace: ws.root,
      lastMigration: MIGRATIONS.at(-1)!.name,
      workingDirectories: [{ path: vault, agent: null }],
      includesData: false,
    });
    expect(readdirSync(dir).sort()).toEqual([
      'config.yaml',
      'pero-backup.json',
      'pero.sqlite',
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

  it('includes the data folder when asked, without links or the state directory', async () => {
    // Startup wrote the default notes in the system folder.
    await withDataFolder(vault);
    rmSync(join(vault, 'System'), { recursive: true });
    mkdirSync(join(vault, 'System'));
    writeFileSync(join(vault, 'System', 'Pero.md'), 'Be brief.\n');
    symlinkSync('/etc', join(vault, 'etc'));
    const file = join(tmp, 'backup.tgz');

    await expect(backups.create(file)).resolves.toMatchObject({
      includesData: false,
    });
    const plain = await extract(file);
    expect(plain.manifest.includesData).toBe(false);
    expect(readdirSync(plain.dir)).not.toContain('data');
    rmSync(plain.dir, { recursive: true });

    const result = await backups.create(file, { includeData: true });

    expect(result).toMatchObject({ includesData: true });
    const { dir, manifest } = await extract(file);
    expect(manifest).toMatchObject({ format: 1, includesData: true });
    expect(readdirSync(join(dir, 'data'))).toEqual(['System']);
    expect(readFileSync(join(dir, 'data', 'System', 'Pero.md'), 'utf8')).toBe(
      'Be brief.\n',
    );
    expect(readdirSync(tmp).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('leaves out the state directory and .env of a workspace inside its data folder', async () => {
    await moduleRef.close();
    await boot('data: .\n');
    writeFileSync(join(ws.root, '.env'), 'PERO_TELEGRAM_BOT_TOKEN=x\n');
    writeFileSync(join(ws.root, 'note.md'), 'Hi');
    const file = join(tmp, 'backup.tgz');

    await backups.create(file, { includeData: true });

    const { dir, manifest } = await extract(file);
    expect(readdirSync(join(dir, 'data')).sort()).toEqual([
      'System',
      'data',
      'note.md',
    ]);
    expect(manifest.workingDirectories).toEqual([
      { path: ws.root, agent: null },
    ]);
  });

  it("records the data folder and the Agents' own folders", async () => {
    await ws.agent('Coder', { 'working-directory': own });
    await ws.agent('Notes');
    await moduleRef.close();
    await boot();
    const file = join(tmp, 'backup.tgz');

    await backups.create(file);

    expect((await extract(file)).manifest.workingDirectories).toEqual([
      { path: ws.dataFolder, agent: null },
      { path: own, agent: 'coder' },
    ]);
  });

  it('refuses to include the data folder into itself', async () => {
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
      [
        join(layout.stateDir, 'backup.tgz'),
        /must be outside the state directory/,
      ],
      [layout.stateDir, /must be outside the state directory/],
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
