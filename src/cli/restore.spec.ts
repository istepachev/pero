import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  let ws: string;
  let root: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-restore-ws-')));
    ws = join(tmp, 'ws');
    root = join(ws, '.pero');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A backup with `config` as its config.yaml, and `data`. */
  async function backup(
    options: {
      config?: string;
      data?: Record<string, string>;
    } = {},
  ): Promise<string> {
    const staging = join(tmp, 'staging');
    mkdirSync(staging);
    const manifest: BackupManifest = {
      format: 1,
      peroVersion: '1.2.3',
      createdAt: '2026-09-28T00:00:00.000Z',
      sourceWorkspace: '/srv/ws',
      lastMigration: null,
      workingDirectories: [
        { path: '/srv/ws/data', agent: null },
        { path: join(tmp, 'gone'), agent: 'coder' },
      ],
      includesData: options.data !== undefined,
    };
    writeFileSync(join(staging, MANIFEST_ENTRY), JSON.stringify(manifest));
    writeFileSync(join(staging, DATABASE_ENTRY), DATABASE);
    if (options.config !== undefined) {
      writeFileSync(join(staging, 'config.yaml'), options.config);
    }
    for (const [path, text] of Object.entries(options.data ?? {})) {
      mkdirSync(dirname(join(staging, 'data', path)), { recursive: true });
      writeFileSync(join(staging, 'data', path), text);
    }
    const file = join(tmp, 'backup.tgz');
    await writeBackupArchive(staging, file);
    rmSync(staging, { recursive: true });
    return file;
  }

  const read = (path: string) => readFileSync(join(ws, path), 'utf8');

  it('restores into a new workspace, with its config.yaml and data folder', async () => {
    const file = await backup({
      config: 'data: notes\n',
      data: { 'Settings/Pero.md': 'Hi', 'a.md': 'A' },
    });

    const result = await restoreBackup(file, root, ws);

    expect(result).toMatchObject({
      dataDir: root,
      config: 'restored',
      notAllowed: [],
      data: { folder: join(ws, 'notes'), copied: 2, kept: 0 },
      missing: [{ path: join(tmp, 'gone'), agent: 'coder' }],
    });
    expect(readdirSync(root).sort()).toEqual([
      '.gitignore',
      'config.yaml',
      'logs',
      'pero.sqlite',
      'run',
    ]);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, DATABASE_ENTRY))).toEqual(DATABASE);
    expect(read('notes/Settings/Pero.md')).toBe('Hi');
    expect(readdirSync(ws).sort()).toEqual(['.pero', 'notes']);
  });

  it('keeps what a clone already has: config.yaml and data files', async () => {
    mkdirSync(join(root), { recursive: true });
    mkdirSync(join(ws, 'data'));
    writeFileSync(join(root, 'config.yaml'), '# mine\ndata: data\n');
    writeFileSync(join(ws, 'data', 'a.md'), 'newer');
    const file = await backup({
      config: 'telegram:\n  allowed-chats:\n    - id: -100123\n    - id: 42\n',
      data: { 'a.md': 'older', 'b.md': 'B' },
    });

    const result = await restoreBackup(file, root, ws);

    expect(result).toMatchObject({
      config: 'kept',
      notAllowed: ['-100123', '42'],
      data: { folder: join(ws, 'data'), copied: 1, kept: 1 },
      missing: [{ path: join(tmp, 'gone'), agent: 'coder' }],
    });
    expect(read('.pero/config.yaml')).toBe('# mine\ndata: data\n');
    expect(read('data/a.md')).toBe('newer');
    expect(read('data/b.md')).toBe('B');
  });

  it("says when config.yaml is the same as the backup's", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.yaml'), 'data: data\n');
    const file = await backup({ config: 'data: data\n' });

    await expect(restoreBackup(file, root, ws)).resolves.toMatchObject({
      config: 'unchanged',
      notAllowed: [],
      missing: [
        { path: join(ws, 'data'), agent: null },
        { path: join(tmp, 'gone'), agent: 'coder' },
      ],
    });
  });

  it('replaces config.yaml when asked', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.yaml'), '# mine\n');
    const file = await backup({ config: 'data: notes\n' });

    const result = await restoreBackup(file, root, ws, {
      replaceConfig: true,
    });

    expect(result.config).toBe('replaced');
    expect(read('.pero/config.yaml')).toBe('data: notes\n');
    // No data in the backup, and the data folder is not there yet.
    expect(result.missing).toContainEqual({
      path: join(ws, 'notes'),
      agent: null,
    });
  });

  it('refuses a workspace with a database and changes nothing', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pero.sqlite-wal'), '');
    const file = await backup({
      config: 'data: notes\n',
      data: { 'a.md': 'A' },
    });

    const result = restoreBackup(file, root, ws);

    await expect(result).rejects.toThrow(CliError);
    await expect(result).rejects.toThrow(`${root} already has a database`);
    expect(readdirSync(ws)).toEqual(['.pero']);
    expect(readdirSync(root)).toEqual(['pero.sqlite-wal']);
  });

  it("stops before changing anything when the workspace's config.yaml is invalid", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.yaml'), 'dta: notes\n');
    const file = await backup({ config: 'data: notes\n' });

    await expect(restoreBackup(file, root, ws)).rejects.toThrow(/dta/);
    expect(readdirSync(root)).toEqual(['config.yaml']);
    expect(readdirSync(ws)).toEqual(['.pero']);

    await expect(
      restoreBackup(file, root, ws, { replaceConfig: true }),
    ).resolves.toMatchObject({ config: 'replaced' });
  });

  it('leaves nothing behind for an archive that is not a backup', async () => {
    const junk = join(tmp, 'junk.tgz');
    writeFileSync(junk, 'not an archive');

    await expect(restoreBackup(junk, root, ws)).rejects.toThrow(
      BackupFormatError,
    );
    expect(readdirSync(tmp)).toEqual(['junk.tgz']);

    mkdirSync(ws);
    await expect(restoreBackup(junk, root, ws)).rejects.toThrow(
      BackupFormatError,
    );
    expect(readdirSync(ws)).toEqual([]);
  });
});
