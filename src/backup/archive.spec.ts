import {
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
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupFormatError,
  type BackupManifest,
  DATABASE_ENTRY,
  extractBackupArchive,
  MANIFEST_ENTRY,
  missingFolders,
  writeBackupArchive,
} from './archive.js';

const DATABASE = Buffer.concat([
  Buffer.from('SQLite format 3\0', 'latin1'),
  Buffer.alloc(84, 1),
]);

describe('backup archive', () => {
  let tmp: string;
  let staging: string;
  let target: string;
  let manifest: BackupManifest;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-archive-'));
    staging = join(tmp, 'staging');
    target = join(tmp, 'target');
    mkdirSync(staging);
    mkdirSync(target);
    manifest = {
      format: 1,
      peroVersion: '1.2.3',
      createdAt: '2026-09-28T00:00:00.000Z',
      sourceDataDir: '/home/owner/.pero',
      lastMigration: 'CreateDomainTables1790523956072',
      workingDirectories: [],
      secrets: ['telegram-bot-token'],
    };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function stage(options: { manifest?: unknown; database?: Buffer } = {}) {
    writeFileSync(
      join(staging, MANIFEST_ENTRY),
      JSON.stringify(options.manifest ?? manifest),
    );
    writeFileSync(join(staging, DATABASE_ENTRY), options.database ?? DATABASE);
    mkdirSync(join(staging, 'secrets'), { recursive: true });
    writeFileSync(join(staging, 'secrets', 'telegram-bot-token'), 'token\n', {
      mode: 0o644,
    });
  }

  /** An archive of `entries` in `staging`, written without Pero's checks. */
  async function rawArchive(entries: string[]): Promise<string> {
    const file = join(tmp, 'raw.tgz');
    await tar.c({ gzip: true, cwd: staging, file }, entries);
    return file;
  }

  it('round-trips, owner-only, leaving no temporary file', async () => {
    stage();
    const file = join(tmp, 'backup.tgz');

    await writeBackupArchive(staging, file);
    const extracted = await extractBackupArchive(file, target);

    expect(extracted).toEqual(manifest);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(tmp).sort()).toEqual([
      'backup.tgz',
      'staging',
      'target',
    ]);
    expect(readFileSync(join(target, DATABASE_ENTRY))).toEqual(DATABASE);
    expect(
      readFileSync(join(target, 'secrets', 'telegram-bot-token'), 'utf8'),
    ).toBe('token\n');
    for (const path of [
      DATABASE_ENTRY,
      MANIFEST_ENTRY,
      'secrets/telegram-bot-token',
    ]) {
      expect(statSync(join(target, path)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(join(target, 'secrets')).mode & 0o777).toBe(0o700);
  });

  it('replaces an earlier backup in one step', async () => {
    stage();
    const file = join(tmp, 'backup.tgz');
    writeFileSync(file, 'old');

    await writeBackupArchive(staging, file);

    await expect(extractBackupArchive(file, target)).resolves.toEqual(manifest);
  });

  it('leaves nothing behind when writing fails', async () => {
    const file = join(tmp, 'backup.tgz');

    // Nothing staged: the manifest and database are missing.
    await expect(writeBackupArchive(staging, file)).rejects.toThrow();

    expect(readdirSync(tmp).sort()).toEqual(['staging', 'target']);
  });

  it('works without secrets', async () => {
    stage();
    rmSync(join(staging, 'secrets'), { recursive: true });
    const file = join(tmp, 'backup.tgz');

    await writeBackupArchive(staging, file);
    await extractBackupArchive(file, target);

    expect(readdirSync(target).sort()).toEqual([
      MANIFEST_ENTRY,
      DATABASE_ENTRY,
    ]);
  });

  it('rejects a file that is not an archive', async () => {
    const file = join(tmp, 'junk.tgz');
    writeFileSync(file, 'not an archive');

    await expect(extractBackupArchive(file, target)).rejects.toThrow(
      BackupFormatError,
    );
  });

  it('rejects a missing file', async () => {
    await expect(
      extractBackupArchive(join(tmp, 'missing.tgz'), target),
    ).rejects.toThrow(/does not exist/);
  });

  it('rejects an archive without a valid manifest', async () => {
    stage({ manifest: { format: 1, peroVersion: 1 } });
    const file = join(tmp, 'backup.tgz');
    await writeBackupArchive(staging, file);

    await expect(extractBackupArchive(file, target)).rejects.toThrow(
      /is not a Pero backup: pero-backup\.json\.peroVersion/,
    );
  });

  it('asks for a newer Pero for a newer backup format', async () => {
    stage({ manifest: { ...manifest, format: 2 } });
    const file = join(tmp, 'backup.tgz');
    await writeBackupArchive(staging, file);

    await expect(extractBackupArchive(file, target)).rejects.toThrow(
      /newer Pero \(backup format 2\)/,
    );
  });

  it('rejects a database that is not SQLite', async () => {
    stage({ database: Buffer.from('plain text') });
    const file = join(tmp, 'backup.tgz');
    await writeBackupArchive(staging, file);

    await expect(extractBackupArchive(file, target)).rejects.toThrow(
      /pero\.sqlite is not an SQLite database/,
    );
  });

  it('rejects entries a backup never has', async () => {
    stage();
    writeFileSync(join(staging, 'extra.txt'), 'x');

    const file = await rawArchive([
      MANIFEST_ENTRY,
      DATABASE_ENTRY,
      'extra.txt',
    ]);

    await expect(extractBackupArchive(file, target)).rejects.toThrow(
      /unexpected entry extra\.txt/,
    );
    expect(readdirSync(target)).not.toContain('extra.txt');
  });

  it('rejects links instead of following them', async () => {
    stage();
    symlinkSync('/etc/passwd', join(staging, 'secrets', 'link'));

    const file = await rawArchive([MANIFEST_ENTRY, DATABASE_ENTRY, 'secrets']);

    await expect(extractBackupArchive(file, target)).rejects.toThrow(
      /unexpected entry secrets\/link/,
    );
    expect(readdirSync(join(target, 'secrets'))).not.toContain('link');
  });

  it('lists recorded folders that are missing', async () => {
    const present = join(tmp, 'vault');
    mkdirSync(present);
    const file = join(tmp, 'a-file');
    writeFileSync(file, '');

    const missing = await missingFolders({
      ...manifest,
      workingDirectories: [
        { path: present, agent: null },
        { path: join(tmp, 'gone'), agent: 'coder' },
        { path: file, agent: 'writer' },
      ],
    });

    expect(missing).toEqual([
      { path: join(tmp, 'gone'), agent: 'coder' },
      { path: file, agent: 'writer' },
    ]);
  });
});
