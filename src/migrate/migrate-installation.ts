import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { writeFileAtomic } from '../config/atomic-file.js';
import { isHomeFolder, STATE_DIR_NAME } from '../config/bootstrap-config.js';
import {
  dataDirLayout,
  type DataDirLayout,
  ensureDataDir,
} from '../config/data-dir.js';
import {
  ensureGitignoreLine,
  readEnvFile,
  setEnvValue,
} from '../config/env-file.js';
import {
  allowChat,
  dataFolderValue,
  defaultHostConfig,
  editHostConfig,
  type HostConfig,
  HOST_CONFIG_FILE,
  readHostConfig,
  resolveSettingsFolder,
  setDataFolder,
} from '../config/host-config.js';
import { readSecret } from '../config/secret-store.js';
import {
  TELEGRAM_TOKEN_ENV,
  TELEGRAM_TOKEN_SECRET,
} from '../config/settings-input.js';
import { initWorkspace, SKELETON_NOTES } from '../config/workspace-skeleton.js';
import {
  createControlClient,
  DaemonNotRunningError,
} from '../control/client.js';
import { readDaemonMetadata } from '../control/daemon-metadata.js';
import { ControlError } from '../control/protocol.js';
import { acquireDaemonLock, type DaemonLock } from '../daemon/daemon-lock.js';
import {
  type Installation,
  readInstallation,
  splitWorkflowSchedules,
} from '../definitions/installation.js';
import { dataSourceOptions } from '../persistence/data-source-options.js';
import { openDatabase } from '../persistence/open-database.js';
import { channelTopicLookup } from '../settings-notes/channel-topics.js';
import {
  checkWorkspace,
  type WorkspaceCheck,
} from '../settings-files/check.js';
import { CliError } from '../cli/errors.js';
import { type PlannedNote, planNotes } from './notes-from-installation.js';

// `pero migrate`: the one CLI command that opens a database, a copy of the
// legacy one, while no daemon uses it. Loaded only when the command runs,
// so the rest of the CLI never loads TypeORM.

const DATABASE = 'pero.sqlite';

export interface MigrateInput {
  /** The legacy data directory, absolute. */
  source: string;
  /** The workspace to make, absolute. */
  workspace: string;
  homeDir: string;
  hostTimeZone: string;
}

/** What `pero migrate` did with one file. */
export interface MigrateEntry {
  /** Relative to the workspace when inside it. */
  path: string;
  /** `updated`: a file of `pero init`'s skeleton replaced or extended. */
  action: 'created' | 'updated' | 'kept' | 'removed';
}

export interface MigrateResult {
  workspace: string;
  entries: MigrateEntry[];
  /** What changed in meaning, or had no place in notes. */
  notices: string[];
  /** `pero check` of the new workspace. */
  check: WorkspaceCheck;
}

/**
 * Converts the legacy data directory `source` into a workspace at
 * `workspace`, leaving `source` untouched: its database is copied while
 * the daemon lock is held, then the copy is migrated and read. Everything
 * is read and checked before the workspace is written, and the database
 * lands last, so a failed migration can simply run again.
 */
export async function migrateInstallation(
  input: MigrateInput,
): Promise<MigrateResult> {
  const { source, workspace, homeDir } = input;
  const layout = dataDirLayout(source);
  const state = join(workspace, STATE_DIR_NAME);
  await refuseTarget(input, layout);
  await refuseRunningDaemon(layout);

  await mkdir(dirname(workspace), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(workspace), `.${basename(workspace)}-migrate-`),
  );
  try {
    const staged = join(staging, DATABASE);
    copyDatabase(layout, staging);
    const dataSource = await openDatabase(dataSourceOptions(staged));
    let installation: Installation;
    let plan: ReturnType<typeof planNotes>;
    let config: { text: string; value: HostConfig };
    try {
      installation = await readInstallation(dataSource);
      config = newConfig(layout, workspace, installation, staging);
      const allowed = new Set(
        config.value.allowedChats.map((chat) => chat.chatKey),
      );
      plan = planNotes(installation, { allowedChats: allowed });
      if (plan.conflicts.length > 0) {
        throw new CliError(
          [
            'Nothing was written: each topic title must lead to one Agent. Rename one of each of these topics in Telegram (or fix it with pero agents and pero channels), then run pero migrate again:',
            ...plan.conflicts.map((conflict) => `  ${conflict}`),
          ].join('\n'),
        );
      }
      await splitWorkflowSchedules(dataSource, plan.splits);
    } finally {
      await dataSource.destroy();
    }

    const settings = resolveSettingsFolder(config.value, workspace, homeDir);
    const notes = await sortNotes(plan.notes, settings);
    if (notes.conflicting.length > 0) {
      throw new CliError(
        [
          `Nothing was written: these notes already exist with other content. Move them aside, or migrate into another folder:`,
          ...notes.conflicting.map((path) => `  ${shown(workspace, path)}`),
        ].join('\n'),
      );
    }

    // Writing starts here.
    const entries: MigrateEntry[] = [];
    const entry = (path: string, action: MigrateEntry['action']) =>
      entries.push({ path: shown(workspace, path), action });
    await mkdir(state, { recursive: true, mode: 0o700 });
    const configFile = join(state, HOST_CONFIG_FILE);
    const hadConfig = existsSync(configFile);
    if (hadConfig && readFileSync(configFile, 'utf8') === config.text) {
      entry(configFile, 'kept');
    } else {
      writeFileAtomic(
        configFile,
        config.text,
        hadConfig ? statSync(configFile).mode & 0o777 : 0o644,
      );
      entry(configFile, hadConfig ? 'updated' : 'created');
    }
    for (const { path, text, action } of notes.writes) {
      if (action !== 'kept') {
        await mkdir(dirname(path), { recursive: true });
        writeFileAtomic(path, text, 0o644);
      }
      entry(path, action);
    }
    for (const path of notes.removals) {
      await rm(path);
      entry(path, 'removed');
    }
    const written = new Set(entries.map((each) => each.path));
    for (const each of initWorkspace(workspace, homeDir, { mainNote: false })
      .entries) {
      if (!written.has(each.path)) entries.push(each);
    }
    const token = moveToken(layout, workspace);
    if (token !== null) entry(join(workspace, '.env'), token);

    await claimDatabase(state, staged);
    ensureDataDir(state, workspace);
    entry(join(state, DATABASE), 'created');

    const check = await checkWorkspace({
      workspace,
      homeDir,
      hostTimeZone: input.hostTimeZone,
      topics: channelTopicLookup(
        installation.channels
          .filter((channel) =>
            config.value.allowedChats.some(
              (chat) => chat.chatKey === channel.key.split(':')[0],
            ),
          )
          .map(({ id, key, title }) => ({ id, key, title })),
      ),
    });
    return { workspace, entries, notices: plan.notices, check };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Refuses a `workspace` that can't be one, or would change `source`. */
async function refuseTarget(
  input: MigrateInput,
  layout: DataDirLayout,
): Promise<void> {
  const { source, workspace, homeDir } = input;
  if (!existsSync(layout.database)) {
    throw new CliError(
      `${source} has no Pero database (${DATABASE}); name the data directory to migrate with --data-dir`,
    );
  }
  if (isHomeFolder(workspace, homeDir)) {
    throw new CliError(
      `${workspace} is your home folder, which can't be a workspace: its .pero is the legacy data directory. Use a folder of its own, such as ~/workspace.`,
    );
  }
  const real = async (path: string) => {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  };
  const inside = relative(await real(source), await real(workspace));
  if (inside === '' || !inside.startsWith('..')) {
    throw new CliError(
      `${workspace} is inside the data directory ${source}, which pero migrate leaves untouched; make the workspace in another folder`,
    );
  }
  if (existsSync(join(workspace, DATABASE))) {
    throw new CliError(
      `${workspace} is a Pero data directory; make the workspace in another folder`,
    );
  }
  const state = join(workspace, STATE_DIR_NAME);
  if (existsSync(state)) {
    const names = await readdir(state);
    if (names.some((name) => name.startsWith(DATABASE))) {
      throw new CliError(
        `${workspace} already has a database, in ${state}. Migrate into a workspace without one.`,
      );
    }
  }
}

/**
 * Refuses while a daemon runs for `layout`. The socket check says so
 * kindly; the daemon lock, held while the database is copied, makes sure.
 */
async function refuseRunningDaemon(layout: DataDirLayout): Promise<void> {
  const socket =
    readDaemonMetadata(layout.metadataFile)?.socket ?? layout.controlSocket;
  try {
    await createControlClient(socket).status();
  } catch (error) {
    if (error instanceof DaemonNotRunningError) return;
    if (error instanceof ControlError && error.code === 'connection') return;
    throw error;
  }
  throw running(layout);
}

function running(layout: DataDirLayout): CliError {
  return new CliError(
    `Pero is running for data directory ${layout.root} — stop it with pero stop before migrating`,
  );
}

/**
 * Copies the database files of `layout` into `staging` under the daemon
 * lock, so no daemon writes them meanwhile. The source is only read: its
 * write-ahead log, if any, is copied along and applied to the copy.
 */
function copyDatabase(layout: DataDirLayout, staging: string): void {
  let lock: DaemonLock | null = null;
  // A data directory that never ran a daemon has no lock file; making one
  // would change it.
  if (existsSync(layout.lockFile)) {
    lock = acquireDaemonLock(layout.lockFile);
    if (lock === null) throw running(layout);
  }
  try {
    for (const suffix of ['', '-wal']) {
      const from = `${layout.database}${suffix}`;
      if (!existsSync(from)) continue;
      // Synchronous, so nothing else runs while the lock is held.
      copyFileSync(from, join(staging, `${DATABASE}${suffix}`));
    }
  } finally {
    lock?.release();
  }
}

/**
 * The workspace's `config.yaml`: its own when it has one, or else the
 * legacy one, or else the default; with the data folder set to the old
 * default working directory and every chat still in `allowed_chats`
 * allowed. Worked out in `staging`, written later.
 */
function newConfig(
  layout: DataDirLayout,
  workspace: string,
  installation: Installation,
  staging: string,
): { text: string; value: HostConfig } {
  const own = join(workspace, STATE_DIR_NAME, HOST_CONFIG_FILE);
  const start = existsSync(own)
    ? own
    : existsSync(layout.configFile)
      ? layout.configFile
      : null;
  const scratch = join(staging, HOST_CONFIG_FILE);
  if (start !== null) {
    // Check the file where the owner can find it, before copying it.
    readHostConfig(start);
    writeFileAtomic(scratch, readFileSync(start, 'utf8'), 0o600);
  }
  const { dataFolder } = installation.defaults;
  const value = editHostConfig(
    scratch,
    (document) => {
      if (dataFolder !== null) {
        setDataFolder(document, dataFolderValue(dataFolder, workspace));
      }
      for (const chat of installation.allowedChats) {
        allowChat(document, chat.chatKey, chat.title);
      }
    },
    () => defaultHostConfig(),
  );
  return { text: readFileSync(scratch, 'utf8'), value };
}

/** A planned note at its absolute path, and what writing it does. */
interface NoteWrite {
  path: string;
  text: string;
  action: 'created' | 'updated' | 'kept';
}

/**
 * The notes of `planned` sorted by what writing them into `settings` does:
 * a missing note is created, an identical one kept, and one of `pero
 * init`'s skeleton replaced. Any other existing note is conflicting. The
 * skeleton's `Agents/Main.md` goes when nothing is planned in its place,
 * since it would be one more Agent.
 */
async function sortNotes(
  planned: readonly PlannedNote[],
  settings: string,
): Promise<{ writes: NoteWrite[]; removals: string[]; conflicting: string[] }> {
  const writes: NoteWrite[] = [];
  const conflicting: string[] = [];
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  for (const { path: file, text } of planned) {
    const path = join(settings, file);
    const existing = read(path);
    if (existing === null) {
      writes.push({ path, text, action: 'created' });
    } else if (existing === text) {
      writes.push({ path, text, action: 'kept' });
    } else if (existing === SKELETON_NOTES[file]) {
      writes.push({ path, text, action: 'updated' });
    } else {
      conflicting.push(path);
    }
  }
  const removals: string[] = [];
  const main = 'Agents/Main.md';
  if (
    !planned.some((note) => note.path === main) &&
    read(join(settings, main)) === SKELETON_NOTES[main]
  ) {
    removals.push(join(settings, main));
  }
  return { writes, removals, conflicting };
}

/**
 * Writes the legacy bot token into the workspace's `.env`, unless it has
 * one: `created`, `kept`, or null when there is no token to move.
 */
function moveToken(
  layout: DataDirLayout,
  workspace: string,
): MigrateEntry['action'] | null {
  const token = readSecret(layout.secrets, TELEGRAM_TOKEN_SECRET);
  if (token === null) return null;
  const envFile = join(workspace, '.env');
  if (readEnvFile(envFile)?.get(TELEGRAM_TOKEN_ENV)?.trim()) return 'kept';
  const existed = existsSync(envFile);
  setEnvValue(envFile, TELEGRAM_TOKEN_ENV, token);
  ensureGitignoreLine(join(workspace, '.gitignore'), '.env');
  return existed ? 'updated' : 'created';
}

/** Puts the migrated copy at `state`, unless a database appeared there. */
async function claimDatabase(state: string, staged: string): Promise<void> {
  const names = await readdir(state);
  if (names.some((name) => name.startsWith(DATABASE))) {
    throw new CliError(
      `${state} got a database while migrating; move it aside and run pero migrate again`,
    );
  }
  await copyFile(staged, join(state, DATABASE), constants.COPYFILE_EXCL);
}

function shown(workspace: string, path: string): string {
  const inside = relative(workspace, path);
  return inside.startsWith('..') ? path : inside;
}
