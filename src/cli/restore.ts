import { constants, existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BackupManifest,
  CONFIG_ENTRY,
  DATA_ENTRY,
  DATABASE_ENTRY,
  extractBackupArchive,
  missingFolders,
  type WorkingDirectoryRef,
} from '../backup/archive.js';
import { copyTree, type CopyTreeResult } from '../backup/copy-tree.js';
import { writeFileAtomic } from '../config/atomic-file.js';
import { ensureDataDir } from '../config/data-dir.js';
import {
  type HostConfig,
  readHostConfig,
  resolveDataFolder,
} from '../config/host-config.js';
import { CliError } from './errors.js';

export interface RestoreOptions {
  /** Replace the workspace's own `config.yaml` with the backup's. */
  replaceConfig?: boolean;
}

export interface RestoreResult {
  /** The state directory the backup now lives in. */
  dataDir: string;
  manifest: BackupManifest;
  /**
   * Folders the restored workspace uses that do not exist here: the data
   * folder (`agent` null) and each Agent's own folder.
   */
  missing: WorkingDirectoryRef[];
  /**
   * What became of the backup's `config.yaml`: `kept` when the workspace
   * already had its own, `unchanged` when that one is the same, and null
   * when the backup has none.
   */
  config: 'restored' | 'replaced' | 'kept' | 'unchanged' | null;
  /** With `config` kept: chats the backup's file allowed and this one doesn't. */
  notAllowed: string[];
  /** The backup's data folder, copied without overwriting; null without one. */
  data: (CopyTreeResult & { folder: string }) | null;
}

/**
 * Restores backup `file` into `workspace`, such as a fresh clone of its
 * repository, whose state directory `root` has no database; both are
 * created when missing. The workspace may already hold files, so each is
 * copied without overwriting:
 * - the database first, which claims `root`: a daemon that started
 *   meanwhile makes the restore stop there, with nothing changed;
 * - `config.yaml`, unless the workspace has its own and `replaceConfig`
 *   is not set;
 * - the data folder, if the backup has it, where the workspace's
 *   `config.yaml` puts it, keeping every file already there.
 */
export async function restoreBackup(
  file: string,
  root: string,
  workspace: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const target = await existing(root);
  if (target !== null) await refuseDatabase(root, target);

  const createdWorkspace = await mkdir(workspace, { recursive: true });
  const staging = join(workspace, `.pero.restore-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  let state = target ?? root;
  try {
    const manifest = await extractBackupArchive(file, staging);
    const stagedConfig = join(staging, CONFIG_ENTRY);
    const ownConfig = join(state, CONFIG_ENTRY);
    // The config.yaml in use afterwards, read now: an invalid one stops
    // the restore before anything changes.
    const hostConfig = readHostConfig(
      existsSync(stagedConfig) &&
        (options.replaceConfig || !existsSync(ownConfig))
        ? stagedConfig
        : ownConfig,
    );
    state = await claimDatabase(root, staging);

    const config = await restoreConfig(
      stagedConfig,
      join(state, CONFIG_ENTRY),
      options.replaceConfig ?? false,
    );

    const folder = resolveDataFolder(
      hostConfig ?? { data: null },
      workspace,
      true,
    )!;
    const data = manifest.includesData
      ? {
          folder,
          ...(await copyTree(join(staging, DATA_ENTRY), folder)),
        }
      : null;

    ensureDataDir(state, workspace);
    return {
      dataDir: state,
      manifest,
      missing: await missingHere(manifest, hostConfig === null ? null : folder),
      config: config.action,
      notAllowed: config.notAllowed,
      data,
    };
  } catch (error) {
    if (
      createdWorkspace !== undefined &&
      !existsSync(join(state, DATABASE_ENTRY))
    ) {
      await rm(createdWorkspace, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** `path` through any links, or null when it does not exist. */
async function existing(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Refuses a state directory `target` that has a database, or is no folder. */
async function refuseDatabase(root: string, target: string): Promise<void> {
  if (!(await stat(target)).isDirectory()) {
    throw new CliError(`${root} is not a folder`);
  }
  const names = await readdir(target);
  if (names.some((name) => name.startsWith(DATABASE_ENTRY))) {
    throw hasDatabase(root);
  }
}

/**
 * Copies the snapshot into `root`, created owner-only when missing, unless
 * a database appeared there; returns `root` through any links.
 */
async function claimDatabase(root: string, staging: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = await realpath(root);
  await refuseDatabase(root, target);
  try {
    await copyFile(
      join(staging, DATABASE_ENTRY),
      join(target, DATABASE_ENTRY),
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw hasDatabase(root);
    }
    throw error;
  }
  return target;
}

/** Puts the backup's `config.yaml` at `target` as `replace` says. */
async function restoreConfig(
  staged: string,
  target: string,
  replace: boolean,
): Promise<{ action: RestoreResult['config']; notAllowed: string[] }> {
  if (!existsSync(staged)) return { action: null, notAllowed: [] };
  if (replace && existsSync(target)) {
    writeFileAtomic(target, await readFile(staged, 'utf8'), 0o600);
    return { action: 'replaced', notAllowed: [] };
  }
  try {
    await copyFile(staged, target, constants.COPYFILE_EXCL);
    return { action: 'restored', notAllowed: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const [backup, own] = await Promise.all(
    [staged, target].map((path) => readFile(path, 'utf8')),
  );
  if (backup === own) return { action: 'unchanged', notAllowed: [] };
  return { action: 'kept', notAllowed: chatsOnlyIn(staged, target) };
}

/** Chat IDs allowed in `config.yaml` file `a` and not in `b`. */
function chatsOnlyIn(a: string, b: string): string[] {
  let from: HostConfig | null;
  let to: HostConfig | null;
  try {
    from = readHostConfig(a);
    to = readHostConfig(b);
  } catch {
    // An invalid file is reported when Pero starts.
    return [];
  }
  const kept = new Set(to?.allowedChats.map((chat) => chat.chatKey));
  return (from?.allowedChats ?? [])
    .map((chat) => chat.chatKey)
    .filter((chatKey) => !kept.has(chatKey));
}

/**
 * The folders the restored workspace uses that do not exist: each Agent's
 * own, and the data folder, which is `dataFolder` when the workspace has a
 * `config.yaml` and otherwise the one the backup recorded.
 */
async function missingHere(
  manifest: BackupManifest,
  dataFolder: string | null,
): Promise<WorkingDirectoryRef[]> {
  if (dataFolder === null) return missingFolders(manifest);
  return missingFolders({
    ...manifest,
    workingDirectories: [
      { path: dataFolder, agent: null },
      ...manifest.workingDirectories.filter((folder) => folder.agent !== null),
    ],
  });
}

function hasDatabase(root: string): CliError {
  return new CliError(
    `${root} already has a database. Restore into a workspace without one, such as a fresh clone, or stop Pero and move ${join(root, DATABASE_ENTRY)} aside first.`,
  );
}
