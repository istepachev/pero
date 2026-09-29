import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type BackupManifest,
  extractBackupArchive,
  MANIFEST_ENTRY,
  missingFolders,
  type WorkingDirectoryRef,
} from '../backup/archive.js';
import { ensureDataDir } from '../config/data-dir.js';
import { CliError } from './errors.js';

export interface RestoreResult {
  /** The data directory the backup now lives in. */
  dataDir: string;
  manifest: BackupManifest;
  /** Working folders the records point to that do not exist here. */
  missing: WorkingDirectoryRef[];
}

/**
 * Restores backup `file` as the state directory `root` of `workspace` (null
 * for a legacy data directory), which must be missing or empty. The archive is unpacked next to `root` and renamed into
 * place in one step, which fails if anything, such as a starting daemon,
 * wrote to `root` meanwhile. On failure nothing is left behind.
 */
export async function restoreBackup(
  file: string,
  root: string,
  workspace: string | null = null,
): Promise<RestoreResult> {
  const target = await prepareTarget(root);
  const staging = join(
    dirname(target),
    `.${basename(target)}.restore-${process.pid}`,
  );
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  let manifest: BackupManifest;
  try {
    manifest = await extractBackupArchive(file, staging);
    // Its contents are reported below; it is not part of a data directory.
    await rm(join(staging, MANIFEST_ENTRY));
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') throw notEmpty(target);
    throw error;
  }
  ensureDataDir(target, workspace);
  return { dataDir: target, manifest, missing: await missingFolders(manifest) };
}

/** The directory to restore into, once it is known to be missing or empty. */
async function prepareTarget(root: string): Promise<string> {
  let target: string;
  try {
    // Restore where a linked data directory points, not over the link.
    target = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(root), { recursive: true });
    return root;
  }
  if (!(await stat(target)).isDirectory()) {
    throw new CliError(`${root} is not a folder`);
  }
  if ((await readdir(target)).length > 0) throw notEmpty(root);
  return target;
}

function notEmpty(root: string): CliError {
  return new CliError(
    `${root} is not empty. Restore into a new data directory, or stop Pero and move ${root} aside first.`,
  );
}
