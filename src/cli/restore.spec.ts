import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupFormatError,
  type BackupManifest,
  DATABASE_ENTRY,
  MANIFEST_ENTRY,
  writeBackupArchive,
} from '../backup/archive.js';
import { CliError } from './errors.js';
import { restoreBackup } from './restore.js';

const DATABASE = Buffer.concat([
  Buffer.from('SQLite format 3\0', 'latin1'),
  Buffer.alloc(84, 1),
]);

describe('restoreBackup', () => {
  let tmp: string;
  let file: string;
  let vault: string;
  let manifest: BackupManifest;

  beforeEach(async () => {
    // Resolved: on macOS the temporary folder is behind a link.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-restore-')));
    vault = join(tmp, 'vault');
    mkdirSync(vault);
    manifest = {
      format: 1,
      peroVersion: '1.2.3',
      createdAt: '2026-09-28T00:00:00.000Z',
      sourceDataDir: '/home/owner/.pero',
      lastMigration: null,
      workingDirectories: [
        { path: vault, agent: null },
        { path: join(tmp, 'gone'), agent: 'coder' },
      ],
      secrets: ['telegram-bot-token'],
    };
    const staging = join(tmp, 'staging');
    mkdirSync(join(staging, 'secrets'), { recursive: true });
    writeFileSync(join(staging, MANIFEST_ENTRY), JSON.stringify(manifest));
    writeFileSync(join(staging, DATABASE_ENTRY), DATABASE);
    writeFileSync(join(staging, 'secrets', 'telegram-bot-token'), 'token\n');
    file = join(tmp, 'backup.tgz');
    await writeBackupArchive(staging, file);
    rmSync(staging, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Everything in `tmp` apart from the fixtures. */
  function leftovers(): string[] {
    return readdirSync(tmp).filter(
      (name) => name !== 'vault' && name !== 'backup.tgz',
    );
  }

  it('restores into a missing directory, owner-only, and reports missing folders', async () => {
    const root = join(tmp, 'nested', 'pero');

    const result = await restoreBackup(file, root);

    expect(result).toEqual({
      dataDir: root,
      manifest,
      missing: [{ path: join(tmp, 'gone'), agent: 'coder' }],
    });
    expect(readdirSync(root).sort()).toEqual([
      'logs',
      'pero.sqlite',
      'run',
      'secrets',
    ]);
    expect(readFileSync(join(root, DATABASE_ENTRY))).toEqual(DATABASE);
    for (const dir of ['', 'logs', 'run', 'secrets']) {
      expect(statSync(join(root, dir)).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(tmp, 'nested'))).toEqual(['pero']);
  });

  it('restores into an empty directory', async () => {
    const root = join(tmp, 'pero');
    mkdirSync(root);

    await restoreBackup(file, root);

    expect(readdirSync(root)).toContain('pero.sqlite');
    expect(leftovers()).toEqual(['pero']);
  });

  it('restores where a linked data directory points', async () => {
    const real = join(tmp, 'real');
    mkdirSync(real);
    symlinkSync(real, join(tmp, 'pero'));

    const result = await restoreBackup(file, join(tmp, 'pero'));

    expect(result.dataDir).toBe(real);
    expect(readdirSync(real)).toContain('pero.sqlite');
  });

  it('refuses a directory that is not empty and leaves it untouched', async () => {
    const root = join(tmp, 'pero');
    mkdirSync(root);
    writeFileSync(join(root, 'pero.sqlite'), 'current');

    const result = restoreBackup(file, root);

    await expect(result).rejects.toThrow(CliError);
    await expect(result).rejects.toThrow(/is not empty/);
    expect(readdirSync(root)).toEqual(['pero.sqlite']);
    expect(readFileSync(join(root, 'pero.sqlite'), 'utf8')).toBe('current');
    expect(leftovers()).toEqual(['pero']);
  });

  it('refuses a file in place of the directory', async () => {
    const root = join(tmp, 'pero');
    writeFileSync(root, '');

    await expect(restoreBackup(file, root)).rejects.toThrow(/is not a folder/);
  });

  it('leaves nothing behind for an archive that is not a backup', async () => {
    const junk = join(tmp, 'junk.tgz');
    writeFileSync(junk, 'not an archive');

    await expect(restoreBackup(junk, join(tmp, 'pero'))).rejects.toThrow(
      BackupFormatError,
    );
    expect(leftovers()).toEqual(['junk.tgz']);
  });
});
