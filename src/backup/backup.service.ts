import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Database from 'better-sqlite3';
import type { DataSource } from 'typeorm';
import { ConflictError, InvalidInputError } from '../common/errors.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import type { DataDirLayout } from '../config/data-dir.js';
import type { BackupResult } from '../control/protocol.js';
import { Definitions } from '../definitions/definitions.js';
import {
  BACKUP_FORMAT,
  type BackupManifest,
  CONFIG_ENTRY,
  DATA_BACKUP_FORMAT,
  DATA_ENTRY,
  DATABASE_ENTRY,
  MANIFEST_ENTRY,
  SECRETS_ENTRY,
  writeBackupArchive,
} from './archive.js';
import { copyTree } from './copy-tree.js';

export const BACKUP_LAYOUT = Symbol('BACKUP_LAYOUT');

/** Writes backups of the data directory while the daemon runs. */
@Injectable()
export class BackupService implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Backup');
  private running: Promise<unknown> | undefined;

  constructor(
    @Inject(BACKUP_LAYOUT) private readonly layout: DataDirLayout,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
  ) {}

  /**
   * Writes a backup to the absolute path `file`, replacing any file there.
   * The database is copied with SQLite's online backup API, so work still
   * in the WAL is included and writes may go on meanwhile. With
   * `includeData`, the data folder is copied as it is at that moment,
   * without the state directory and `.env` should they be inside it. One
   * backup runs at a time.
   */
  async create(
    file: string,
    options: { includeData?: boolean } = {},
  ): Promise<BackupResult> {
    if (this.running) {
      throw new ConflictError('A backup is already being written');
    }
    // Claimed before the first await, so shutdown and a second request
    // both see it.
    const work = this.checkDestination(file, options.includeData ?? false).then(
      ({ destination, dataFolder }) => this.write(destination, dataFolder),
    );
    this.running = work;
    try {
      return await work;
    } finally {
      this.running = undefined;
    }
  }

  /** Lets a backup in progress finish before the database closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /** Writes the backup, with `dataFolder` when it is not null. */
  private async write(
    file: string,
    dataFolder: string | null,
  ): Promise<BackupResult> {
    // Next to the backup, on a disk with room for it, rather than in a
    // temporary folder that may be kept in memory.
    const staging = await mkdtemp(
      join(await realpath(dirname(file)), '.pero-backup-'),
    );
    try {
      const snapshot = join(staging, DATABASE_ENTRY);
      const workingDirectories = await this.workingDirectories();
      await this.connection().backup(snapshot);
      await chmod(snapshot, 0o600);
      // A workspace keeps its token in .env, which is never backed up.
      const secrets =
        this.layout.workspace === null
          ? await copySecrets(this.layout.secrets, join(staging, SECRETS_ENTRY))
          : [];
      await copyFile(this.layout.configFile, join(staging, CONFIG_ENTRY)).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        },
      );
      if (dataFolder !== null) {
        // The staging folder too, should a link put the backup inside it.
        const skip = new Set([this.layout.root, staging]);
        if (this.layout.envFile) skip.add(this.layout.envFile);
        await copyTree(dataFolder, join(staging, DATA_ENTRY), skip);
      }
      const manifest: BackupManifest = {
        format: dataFolder === null ? BACKUP_FORMAT : DATA_BACKUP_FORMAT,
        peroVersion: PACKAGE_VERSION,
        createdAt: new Date().toISOString(),
        sourceDataDir: this.layout.root,
        sourceWorkspace: this.layout.workspace,
        lastMigration: describeSnapshot(snapshot),
        workingDirectories,
        secrets,
        ...(dataFolder === null ? {} : { includesData: true }),
      };
      await writeFile(
        join(staging, MANIFEST_ENTRY),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      await writeBackupArchive(staging, file);

      const { size } = await stat(file);
      this.logger.log(`Backup written to ${file} (${size} bytes)`);
      return {
        file,
        createdAt: manifest.createdAt,
        bytes: size,
        includesSecrets: secrets.length > 0,
        includesData: dataFolder !== null,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * The destination, and the data folder to include (null for none), once
   * the backup can be written there.
   */
  private async checkDestination(
    file: string,
    includeData: boolean,
  ): Promise<{ destination: string; dataFolder: string | null }> {
    if (!isAbsolute(file)) {
      throw new InvalidInputError(
        `Backup file ${file} must be an absolute path`,
      );
    }
    const destination = resolve(file);
    if (isInside(destination, this.layout.root)) {
      throw new InvalidInputError(
        `Backup file ${destination} must be outside the data directory ${this.layout.root}`,
      );
    }
    const dataFolder = includeData ? await this.dataFolder() : null;
    if (dataFolder !== null && isInside(destination, dataFolder)) {
      throw new InvalidInputError(
        `Backup file ${destination} must be outside the data folder ${dataFolder} it includes`,
      );
    }
    const parent = dirname(destination);
    const isDirectory = await stat(parent).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    if (!isDirectory) {
      throw new InvalidInputError(`Folder ${parent} does not exist`);
    }
    const existing = await stat(destination).catch(() => undefined);
    if (existing?.isDirectory()) {
      throw new InvalidInputError(`${destination} is a folder`);
    }
    return { destination, dataFolder };
  }

  /** The data folder, which a workspace always has. */
  private async dataFolder(): Promise<string> {
    const { dataFolder: folder } = await this.definitions.defaults();
    if (folder === null) {
      throw new InvalidInputError(
        'There is no data folder to include: a workspace has one, and a legacy data directory has none',
      );
    }
    return folder;
  }

  /**
   * The folders the installation's Agents work in, which a restore checks
   * for: the data folder, and each Agent's own.
   */
  private async workingDirectories(): Promise<
    BackupManifest['workingDirectories']
  > {
    const { dataFolder } = await this.definitions.defaults();
    const agents = await this.definitions.agents();
    return [
      ...(dataFolder === null ? [] : [{ path: dataFolder, agent: null }]),
      ...agents.flatMap(({ name, ownWorkingDirectory }) =>
        ownWorkingDirectory === null
          ? []
          : [{ path: ownWorkingDirectory, agent: name }],
      ),
    ];
  }

  /** The better-sqlite3 connection TypeORM holds. */
  private connection(): Database.Database {
    return (
      this.dataSource.driver as unknown as {
        databaseConnection: Database.Database;
      }
    ).databaseConnection;
  }
}

/** Whether `path` is `folder` or inside it. */
function isInside(path: string, folder: string): boolean {
  const inside = relative(folder, path);
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
}

/**
 * The last migration the snapshot has, and leaves it as one standalone
 * file without a WAL.
 */
function describeSnapshot(snapshot: string): string | null {
  const db = new Database(snapshot);
  try {
    db.pragma('journal_mode = DELETE');
    const migration = db
      .prepare<[], { name: string }>(
        'SELECT "name" FROM "migrations" ORDER BY "timestamp" DESC LIMIT 1',
      )
      .get();
    return migration?.name ?? null;
  } finally {
    db.close();
  }
}

/** Copies the regular files in `from` owner-only and returns their names. */
async function copySecrets(from: string, to: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // Leftovers of an interrupted atomic write are not secrets.
  const names = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) return [];
  await mkdir(to, { mode: 0o700 });
  for (const name of names) {
    await copyFile(join(from, name), join(to, name), constants.COPYFILE_EXCL);
  }
  return names;
}
