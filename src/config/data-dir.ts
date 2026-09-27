import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

const OWNER_ONLY = 0o700;

/** Absolute paths inside a data directory. */
export interface DataDirLayout {
  root: string;
  database: string;
  workspaces: string;
  logs: string;
  logFile: string;
  run: string;
  secrets: string;
}

export class DataDirError extends Error {
  override name = 'DataDirError';
}

/** Returns the layout of `root` without touching the filesystem. */
export function dataDirLayout(root: string): DataDirLayout {
  const logs = join(root, 'logs');
  return {
    root,
    database: join(root, 'pero.sqlite'),
    workspaces: join(root, 'workspaces'),
    logs,
    logFile: join(logs, 'pero.log'),
    run: join(root, 'run'),
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
    for (const dir of [
      layout.workspaces,
      layout.logs,
      layout.run,
      layout.secrets,
    ]) {
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
