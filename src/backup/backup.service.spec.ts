import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import { ConflictError, InvalidInputError } from '../common/errors.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import { type DataDirLayout, ensureDataDir } from '../config/data-dir.js';
import { writeSecret } from '../config/secret-store.js';
import { MIGRATIONS } from '../persistence/migrations/index.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
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
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: layout.database }),
        SettingsModule,
        AgentsModule,
        BackupModule.forRoot({ layout }),
      ],
    }).compile();
    await moduleRef.init();
    backups = moduleRef.get(BackupService);
  });

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

  it('snapshots committed work still in the WAL, with the secrets and a manifest', async () => {
    await moduleRef.get(SettingsService).update({
      defaultWorkingDirectory: vault,
      sharedInstructions: 'Answer in English.',
    });
    await moduleRef.get(AgentsService).create({ name: 'assistant' });
    await moduleRef
      .get(AgentsService)
      .create({ name: 'coder', workingDirectory: own });
    writeSecret(layout.secrets, 'telegram-bot-token', 'secret-token');
    // Not checkpointed: a copy of pero.sqlite alone would miss these rows.
    expect(statSync(`${layout.database}-wal`).size).toBeGreaterThan(0);
    const file = join(tmp, 'backup.tgz');

    const result = await backups.create(file);

    expect(result).toEqual({
      file,
      createdAt: expect.any(String),
      bytes: statSync(file).size,
      includesSecrets: true,
    });
    const { dir, manifest } = await extract(file);
    expect(manifest).toEqual({
      format: 1,
      peroVersion: PACKAGE_VERSION,
      createdAt: result.createdAt,
      sourceDataDir: layout.root,
      lastMigration: MIGRATIONS.at(-1)!.name,
      workingDirectories: [
        { path: vault, agent: null },
        { path: own, agent: 'coder' },
      ],
      secrets: ['telegram-bot-token'],
    });
    expect(readdirSync(dir).sort()).toEqual([
      'pero-backup.json',
      'pero.sqlite',
      'secrets',
    ]);

    const snapshot = new Database(join(dir, DATABASE_ENTRY), {
      readonly: true,
    });
    try {
      expect(snapshot.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(
        snapshot.prepare('SELECT "shared_instructions" FROM "settings"').get(),
      ).toEqual({ shared_instructions: 'Answer in English.' });
      expect(
        snapshot.prepare('SELECT "name" FROM "agents" ORDER BY "name"').all(),
      ).toEqual([{ name: 'assistant' }, { name: 'coder' }]);
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
    expect(readdirSync(dir).sort()).toEqual([
      'pero-backup.json',
      'pero.sqlite',
    ]);
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
