import { constants, existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type BackupManifest,
  CONFIG_ENTRY,
  DATA_ENTRY,
  DATABASE_ENTRY,
  extractBackupArchive,
  MANIFEST_ENTRY,
  missingFolders,
  SECRETS_ENTRY,
  type WorkingDirectoryRef,
} from '../backup/archive.js';
import { copyTree, type CopyTreeResult } from '../backup/copy-tree.js';
import { writeFileAtomic } from '../config/atomic-file.js';
import { ensureDataDir } from '../config/data-dir.js';
import {
  ensureGitignoreLine,
  readEnvFile,
  setEnvValue,
} from '../config/env-file.js';
import {
  type HostConfig,
  readHostConfig,
  resolveDataFolder,
} from '../config/host-config.js';
import { readSecret } from '../config/secret-store.js';
import {
  TELEGRAM_TOKEN_ENV,
  TELEGRAM_TOKEN_SECRET,
} from '../config/settings-input.js';
import { CliError } from './errors.js';

export interface RestoreOptions {
  /** Replace a workspace's own `config.yaml` with the backup's. */
  replaceConfig?: boolean;
}

export interface RestoreResult {
  /** The data directory the backup now lives in. */
  dataDir: string;
  manifest: BackupManifest;
  /**
   * Folders the restored installation uses that do not exist here: the
   * data folder (`agent` null) and each Agent's own folder.
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
  /**
   * A legacy backup's bot token restored into a workspace: `written` to
   * `.env`, or `kept` because `.env` already has one.
   */
  token: 'written' | 'kept' | null;
}

/**
 * Restores backup `file` into state directory `root`. For a workspace,
 * `root` is its `.pero/` and must hold no database; see
 * `restoreIntoWorkspace`. For a legacy data directory (`workspace` null),
 * `root` must be missing or empty: the archive is unpacked next to it and
 * renamed into place in one step, which fails if anything, such as a
 * starting daemon, wrote to `root` meanwhile. On failure before the
 * database is in place, nothing is left behind.
 */
export async function restoreBackup(
  file: string,
  root: string,
  workspace: string | null = null,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  if (workspace !== null) {
    return restoreIntoWorkspace(file, root, workspace, options);
  }
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
    if (manifest.includesData) {
      throw new CliError(
        `${file} includes the data folder, which only a workspace has; restore it with pero restore --workspace <folder>`,
      );
    }
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
  return {
    dataDir: target,
    manifest,
    missing: await missingFolders(manifest),
    config: existsSync(join(target, CONFIG_ENTRY)) ? 'restored' : null,
    notAllowed: [],
    data: null,
    token: null,
  };
}

/**
 * Restores backup `file` into `workspace`, such as a fresh clone of its
 * repository, whose state directory `root` has no database; both are
 * created when missing. Unlike a legacy data directory, the workspace may
 * already hold files, so each is copied without overwriting:
 * - the database first, which claims `root`: a daemon that started
 *   meanwhile makes the restore stop there, with nothing changed;
 * - `config.yaml`, unless the workspace has its own and `replaceConfig`
 *   is not set;
 * - a legacy backup's bot token into `.env`, unless it has one;
 * - the data folder, if the backup has it, where the workspace's
 *   `config.yaml` puts it, keeping every file already there.
 */
async function restoreIntoWorkspace(
  file: string,
  root: string,
  workspace: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const target = await existing(root);
  if (target !== null) await refuseDatabase(root, target);
  const envFile = join(workspace, '.env');
  // Read before anything changes, so an unreadable .env stops it here.
  const envHasToken = Boolean(
    readEnvFile(envFile)?.get(TELEGRAM_TOKEN_ENV)?.trim(),
  );

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

    let token: RestoreResult['token'] = null;
    const legacyToken = readSecret(
      join(staging, SECRETS_ENTRY),
      TELEGRAM_TOKEN_SECRET,
    );
    if (legacyToken) {
      token = envHasToken ? 'kept' : 'written';
      if (!envHasToken) {
        setEnvValue(envFile, TELEGRAM_TOKEN_ENV, legacyToken);
        ensureGitignoreLine(join(workspace, '.gitignore'), '.env');
      }
    }

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
      missing: await missingHere(
        manifest,
        hostConfig === null ? null : folder,
        // A legacy data directory had no data folder of its own to restore.
        hostConfig?.data === null && !manifest.sourceWorkspace,
      ),
      config: config.action,
      notAllowed: config.notAllowed,
      data,
      token,
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
 * The folders the restored installation uses that do not exist: each
 * Agent's own, and the data folder, which is `dataFolder` when the
 * workspace has a `config.yaml` and otherwise the one the backup recorded.
 * With `newDataFolder`, the data folder is left out: Pero creates it.
 */
async function missingHere(
  manifest: BackupManifest,
  dataFolder: string | null,
  newDataFolder: boolean,
): Promise<WorkingDirectoryRef[]> {
  if (dataFolder === null) return missingFolders(manifest);
  const agents = manifest.workingDirectories.filter(
    (folder) => folder.agent !== null,
  );
  return missingFolders({
    ...manifest,
    workingDirectories: newDataFolder
      ? agents
      : [{ path: dataFolder, agent: null }, ...agents],
  });
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

function hasDatabase(root: string): CliError {
  return new CliError(
    `${root} already has a database. Restore into a workspace without one, such as a fresh clone, or stop Pero and move ${join(root, DATABASE_ENTRY)} aside first.`,
  );
}
