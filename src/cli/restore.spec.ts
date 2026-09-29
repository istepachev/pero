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
      config: null,
      notAllowed: [],
      data: null,
      token: null,
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

describe('restoreBackup into a workspace', () => {
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

  /** A backup with `config` as its config.yaml, and `data` or a token. */
  async function backup(
    options: {
      config?: string;
      data?: Record<string, string>;
      token?: string;
    } = {},
  ): Promise<string> {
    const staging = join(tmp, 'staging');
    mkdirSync(staging);
    const manifest: BackupManifest = {
      format: options.data ? 3 : 2,
      peroVersion: '1.2.3',
      createdAt: '2026-09-28T00:00:00.000Z',
      sourceDataDir: options.token ? '/home/owner/.pero' : '/srv/ws/.pero',
      sourceWorkspace: options.token ? null : '/srv/ws',
      lastMigration: null,
      workingDirectories: [
        { path: '/srv/ws/data', agent: null },
        { path: join(tmp, 'gone'), agent: 'coder' },
      ],
      secrets: options.token ? ['telegram-bot-token'] : [],
      ...(options.data ? { includesData: true } : {}),
    };
    writeFileSync(join(staging, MANIFEST_ENTRY), JSON.stringify(manifest));
    writeFileSync(join(staging, DATABASE_ENTRY), DATABASE);
    if (options.config !== undefined) {
      writeFileSync(join(staging, 'config.yaml'), options.config);
    }
    if (options.token) {
      mkdirSync(join(staging, 'secrets'));
      writeFileSync(
        join(staging, 'secrets', 'telegram-bot-token'),
        options.token,
      );
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
      token: null,
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

  it('does not ask for a data folder a legacy backup never had', async () => {
    const file = await backup({
      token: 'legacy-token',
      config: '# data: data\n',
    });

    await expect(restoreBackup(file, root, ws)).resolves.toMatchObject({
      config: 'restored',
      missing: [{ path: join(tmp, 'gone'), agent: 'coder' }],
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

  it("writes a legacy backup's token to .env unless it has one", async () => {
    const file = await backup({ token: 'legacy-token\n' });

    await expect(restoreBackup(file, root, ws)).resolves.toMatchObject({
      token: 'written',
      config: null,
    });
    expect(read('.env')).toBe('PERO_TELEGRAM_BOT_TOKEN=legacy-token\n');
    expect(statSync(join(ws, '.env')).mode & 0o777).toBe(0o600);
    expect(read('.gitignore')).toBe('.env\n');
    expect(readdirSync(root)).not.toContain('secrets');

    rmSync(root, { recursive: true });
    writeFileSync(join(ws, '.env'), 'PERO_TELEGRAM_BOT_TOKEN=mine\n', {
      mode: 0o600,
    });
    await expect(restoreBackup(file, root, ws)).resolves.toMatchObject({
      token: 'kept',
    });
    expect(read('.env')).toBe('PERO_TELEGRAM_BOT_TOKEN=mine\n');
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

  it('refuses a backup with a data folder in a legacy data directory', async () => {
    const file = await backup({ data: { 'a.md': 'A' } });

    await expect(restoreBackup(file, join(tmp, 'legacy'))).rejects.toThrow(
      'includes the data folder, which only a workspace has',
    );
    expect(readdirSync(tmp)).toEqual(['backup.tgz']);
  });
});
