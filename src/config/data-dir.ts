import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

const OWNER_ONLY = 0o700;

/** Absolute paths inside a data directory. */
export interface DataDirLayout {
  root: string;
  database: string;
  logs: string;
  logFile: string;
  /** Plain-text stdout and stderr of a daemon started by `pero run`. */
  daemonOutputFile: string;
  run: string;
  /** Unix socket of the control endpoint; owner-only. */
  controlSocket: string;
  /** Held by the running daemon; the file itself stays after it stops. */
  lockFile: string;
  /** The running daemon's pid, version, and socket; JSON. */
  metadataFile: string;
  secrets: string;
}

export class DataDirError extends Error {
  override name = 'DataDirError';
}

/** Returns the layout of `root` without touching the filesystem. */
export function dataDirLayout(root: string): DataDirLayout {
  const logs = join(root, 'logs');
  const run = join(root, 'run');
  return {
    root,
    database: join(root, 'pero.sqlite'),
    logs,
    logFile: join(logs, 'pero.log'),
    daemonOutputFile: join(logs, 'daemon.out'),
    run,
    controlSocket: join(run, 'pero.sock'),
    lockFile: join(run, 'pero.lock'),
    metadataFile: join(run, 'pero.json'),
    secrets: join(root, 'secrets'),
  };
}

/**
 * Creates the data directory and its subdirectories with owner-only
 * permissions. A root created here is made owner-only; an existing root is
 * left alone because the owner may have pointed Pero at a folder they manage.
 * Pero's own subdirectories are always reset to owner-only.
 */
export function ensureDataDir(root: string): DataDirLayout {
  const layout = dataDirLayout(root);
  try {
    const created = mkdirSync(root, { recursive: true, mode: OWNER_ONLY });
    if (created !== undefined) chmodSync(root, OWNER_ONLY);
    for (const dir of [layout.logs, layout.run, layout.secrets]) {
      mkdirSync(dir, { recursive: true, mode: OWNER_ONLY });
      chmodSync(dir, OWNER_ONLY);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DataDirError(`Cannot prepare data directory ${root}: ${reason}`, {
      cause: error,
    });
  }
  return layout;
}
