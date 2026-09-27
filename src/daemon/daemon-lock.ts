import Database from 'better-sqlite3';

/** Held for the life of a daemon; only one per data directory at a time. */
export interface DaemonLock {
  /** Gives the lock up. Safe to call more than once. */
  release(): void;
}

/**
 * Takes the exclusive lock on `path`, or returns null when another daemon
 * holds it. Node has no `flock`, so an SQLite exclusive transaction holds a
 * kernel file lock instead: the OS drops it when the process exits for any
 * reason, SIGKILL included, so a crash never leaves a stale lock. SQLite also
 * refuses a second connection within the same process.
 *
 * The file itself stays in place after release: removing a lock file that
 * someone may have just opened would let two daemons lock different files.
 */
export function acquireDaemonLock(path: string): DaemonLock | null {
  const db = new Database(path, { timeout: 0 });
  try {
    // A journal in memory keeps `run/` free of `-journal` files.
    db.pragma('journal_mode = MEMORY');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if (isBusy(error)) return null;
    throw error;
  }
  return {
    release: () => {
      if (db.open) db.close();
    },
  };
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Database.SqliteError &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
  );
}
