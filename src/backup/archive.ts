import { createWriteStream } from 'node:fs';
import {
  chmod,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { z } from 'zod';
import { describeIssues } from '../common/errors.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * A backup is a gzip tar holding a manifest, a consistent snapshot of the
 * database, and the owner-only secrets. Logs, `run/`, and working folders
 * are not part of it.
 */

export const MANIFEST_ENTRY = 'pero-backup.json';
export const DATABASE_ENTRY = 'pero.sqlite';
export const SECRETS_ENTRY = 'secrets';

export const BACKUP_FORMAT = 1;

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  peroVersion: z.string(),
  createdAt: z.iso.datetime(),
  /** The data directory the backup was taken from. */
  sourceDataDir: z.string(),
  /** The newest migration the snapshot has applied; null when none. */
  lastMigration: z.string().nullable(),
  /**
   * Folders the records point to, which the backup does not contain: the
   * default working directory (`agent` null) and each Agent's own folder.
   */
  workingDirectories: z.array(
    z.object({ path: z.string(), agent: z.string().nullable() }),
  ),
  /** Names of the files in `secrets/`; never their values. */
  secrets: z.array(z.string()),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

export type WorkingDirectoryRef = BackupManifest['workingDirectories'][number];

/** A file that is not a Pero backup this version can restore. */
export class BackupFormatError extends Error {
  override name = 'BackupFormatError';
}

/**
 * Archives `stagingDir`, which holds the manifest, the database snapshot,
 * and `secrets/`, as `file`. The file is owner-only from the moment it
 * exists and replaces any earlier one in one step.
 */
export async function writeBackupArchive(
  stagingDir: string,
  file: string,
): Promise<void> {
  const entries = [MANIFEST_ENTRY, DATABASE_ENTRY];
  if ((await readdir(stagingDir)).includes(SECRETS_ENTRY)) {
    entries.push(SECRETS_ENTRY);
  }
  const temporary = `${file}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  try {
    await pipeline(
      tar.c({ gzip: true, cwd: stagingDir, portable: true }, entries),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Extracts backup `file` into the empty directory `dir` and returns its
 * manifest. Only the manifest, the database, and regular files in
 * `secrets/` are accepted; anything else fails as `BackupFormatError`, and
 * `dir` may then hold part of the archive.
 */
export async function extractBackupArchive(
  file: string,
  dir: string,
): Promise<BackupManifest> {
  const unexpected: string[] = [];
  try {
    await tar.x({
      file,
      cwd: dir,
      strict: true,
      filter: (path, entry) => {
        const accepted = isBackupEntry(path, 'type' in entry ? entry.type : '');
        if (!accepted) unexpected.push(path);
        return accepted;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BackupFormatError(`${file} does not exist`, { cause: error });
    }
    throw notABackup(file, (error as Error).message, error);
  }
  if (unexpected.length > 0) {
    throw notABackup(file, `unexpected entry ${unexpected[0]}`);
  }

  const manifest = await readManifest(file, dir);
  await checkDatabase(file, join(dir, DATABASE_ENTRY));
  await makeOwnerOnly(dir);
  return manifest;
}

/** The folders in `manifest` that are not accessible directories here. */
export async function missingFolders(
  manifest: BackupManifest,
): Promise<WorkingDirectoryRef[]> {
  const missing: WorkingDirectoryRef[] = [];
  for (const folder of manifest.workingDirectories) {
    const isDirectory = await stat(folder.path).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    if (!isDirectory) missing.push(folder);
  }
  return missing;
}

function isBackupEntry(path: string, type: string): boolean {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 1) {
    if (parts[0] === SECRETS_ENTRY) return type === 'Directory';
    return (
      (parts[0] === MANIFEST_ENTRY || parts[0] === DATABASE_ENTRY) &&
      type === 'File'
    );
  }
  return (
    parts.length === 2 &&
    parts[0] === SECRETS_ENTRY &&
    parts[1] !== '..' &&
    parts[1] !== '.' &&
    type === 'File'
  );
}

async function readManifest(
  file: string,
  dir: string,
): Promise<BackupManifest> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(join(dir, MANIFEST_ENTRY), 'utf8'));
  } catch {
    throw notABackup(file, `${MANIFEST_ENTRY} is missing or not JSON`);
  }
  const format = (json as { format?: unknown } | null)?.format;
  if (typeof format === 'number' && format > BACKUP_FORMAT) {
    throw new BackupFormatError(
      `${file} was made by a newer Pero (backup format ${format}); upgrade Pero to restore it`,
    );
  }
  const manifest = backupManifestSchema.safeParse(json);
  if (!manifest.success) {
    throw notABackup(file, describeIssues(manifest.error, MANIFEST_ENTRY));
  }
  return manifest.data;
}

async function checkDatabase(file: string, database: string): Promise<void> {
  let header: Buffer;
  try {
    const handle = await open(database, 'r');
    try {
      header = Buffer.alloc(SQLITE_HEADER.length);
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
  } catch {
    throw notABackup(file, `${DATABASE_ENTRY} is missing`);
  }
  if (!header.equals(SQLITE_HEADER)) {
    throw notABackup(file, `${DATABASE_ENTRY} is not an SQLite database`);
  }
}

/** Resets what was extracted to owner-only, whatever the archive said. */
async function makeOwnerOnly(dir: string): Promise<void> {
  await chmod(join(dir, MANIFEST_ENTRY), 0o600);
  await chmod(join(dir, DATABASE_ENTRY), 0o600);
  const secrets = join(dir, SECRETS_ENTRY);
  let names: string[];
  try {
    names = await readdir(secrets);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await chmod(secrets, 0o700);
  for (const name of names) await chmod(join(secrets, name), 0o600);
}

function notABackup(
  file: string,
  reason: string,
  cause?: unknown,
): BackupFormatError {
  return new BackupFormatError(`${file} is not a Pero backup: ${reason}`, {
    cause,
  });
}
