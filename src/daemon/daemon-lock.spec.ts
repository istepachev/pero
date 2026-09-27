import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireDaemonLock, type DaemonLock } from './daemon-lock.js';

describe('acquireDaemonLock', () => {
  let tmp: string;
  let lockFile: string;
  const held: DaemonLock[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-lock-'));
    lockFile = join(tmp, 'pero.lock');
  });

  afterEach(() => {
    for (const lock of held.splice(0)) lock.release();
    rmSync(tmp, { recursive: true, force: true });
  });

  function acquire() {
    const lock = acquireDaemonLock(lockFile);
    if (lock) held.push(lock);
    return lock;
  }

  it('refuses a second holder until the first releases', () => {
    const first = acquire();
    expect(first).not.toBeNull();
    expect(acquire()).toBeNull();

    first!.release();
    first!.release();

    expect(acquire()).not.toBeNull();
  });

  it('leaves only the lock file behind', () => {
    const lock = acquire();
    expect(readdirSync(tmp)).toEqual(['pero.lock']);

    lock!.release();

    expect(readdirSync(tmp)).toEqual(['pero.lock']);
  });

  it('is freed when the holding process is killed', async () => {
    // Any exclusive SQLite lock on the file will do; the child runs plain JS.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const db = new (require('better-sqlite3'))(process.argv[1]);
        db.exec('BEGIN EXCLUSIVE');
        console.log('held');
        setInterval(() => {}, 1000);`,
        lockFile,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise((resolve) => holder.stdout.once('data', resolve));

    expect(acquire()).toBeNull();

    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));

    expect(acquire()).not.toBeNull();
  });
});
