import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataDirError, dataDirLayout, ensureDataDir } from './data-dir.js';

const mode = (path: string) => statSync(path).mode & 0o777;

describe('dataDirLayout', () => {
  it('places every file under the root', () => {
    expect(dataDirLayout('/srv/pero')).toEqual({
      root: '/srv/pero',
      database: '/srv/pero/pero.sqlite',
      logs: '/srv/pero/logs',
      logFile: '/srv/pero/logs/pero.log',
      run: '/srv/pero/run',
      controlSocket: '/srv/pero/run/pero.sock',
      secrets: '/srv/pero/secrets',
    });
  });
});

describe('ensureDataDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-data-dir-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the root and subdirectories owner-only', () => {
    const layout = ensureDataDir(join(tmp, 'nested', 'pero'));

    for (const dir of [layout.root, layout.logs, layout.run, layout.secrets]) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(mode(dir)).toBe(0o700);
    }
  });

  it('is idempotent and tightens existing subdirectories', () => {
    const root = join(tmp, 'pero');
    ensureDataDir(root);
    writeFileSync(join(root, 'logs', 'pero.log'), 'kept\n');
    const loose = join(root, 'secrets');
    chmodSync(loose, 0o755);

    ensureDataDir(root);

    expect(mode(loose)).toBe(0o700);
    expect(statSync(join(root, 'logs', 'pero.log')).size).toBe(5);
  });

  it('leaves the permissions of an existing root alone', () => {
    const root = join(tmp, 'shared');
    mkdirSync(root, { mode: 0o755 });

    ensureDataDir(root);

    expect(mode(root)).toBe(0o755);
  });

  it('explains when the root is a file', () => {
    const root = join(tmp, 'file');
    writeFileSync(root, '');

    expect(() => ensureDataDir(root)).toThrow(DataDirError);
    expect(() => ensureDataDir(root)).toThrow(
      `Cannot prepare data directory ${root}:`,
    );
  });
});
