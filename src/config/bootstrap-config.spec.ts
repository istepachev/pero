import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  type DiscoveryFs,
  resolveBootstrapConfig,
  type BootstrapConfigInput,
} from './bootstrap-config.js';

const home = '/home/owner';
const cwd = '/work';

/** A file system holding only `dirs`, where every path is its own real path. */
function fakeFs(...dirs: string[]): DiscoveryFs {
  const existing = new Set(dirs);
  return {
    isDirectory: (path) => existing.has(path),
    realpath: (path) => path,
  };
}

function resolve(input: BootstrapConfigInput = {}) {
  return resolveBootstrapConfig({
    env: {},
    cwd,
    homeDir: home,
    fs: fakeFs(),
    ...input,
  });
}

describe('resolveBootstrapConfig', () => {
  it('defaults to the legacy ~/.pero and info logs', () => {
    expect(resolve()).toEqual({
      dataDir: '/home/owner/.pero',
      workspace: null,
      logLevel: 'info',
    });
  });

  it('uses --workspace, keeping state in its .pero', () => {
    expect(resolve({ workspace: '~/notes' })).toEqual({
      dataDir: '/home/owner/notes/.pero',
      workspace: '/home/owner/notes',
      logLevel: 'info',
    });
  });

  it('refuses --workspace together with --data-dir', () => {
    expect(() => resolve({ workspace: '/ws', dataDir: '/srv/pero' })).toThrow(
      '--workspace: cannot be combined with --data-dir; give one of them',
    );
  });

  it('prefers options, then PERO_WORKSPACE, then PERO_HOME', () => {
    const env = { PERO_WORKSPACE: '/ws', PERO_HOME: '/srv/pero' };
    expect(resolve({ env, dataDir: '/opt/pero' })).toMatchObject({
      dataDir: '/opt/pero',
      workspace: null,
    });
    expect(resolve({ env, workspace: 'here' }).workspace).toBe('/work/here');
    expect(resolve({ env }).workspace).toBe('/ws');
    expect(resolve({ env: { PERO_HOME: '/srv/pero' } })).toMatchObject({
      dataDir: '/srv/pero',
      workspace: null,
    });
  });

  it('finds the nearest folder with .pero/ from the current folder up', () => {
    const fs = fakeFs('/srv/ws/.pero', '/srv/ws/data/.pero');
    expect(resolve({ cwd: '/srv/ws/data/Notes', fs }).workspace).toBe(
      '/srv/ws/data',
    );
    expect(resolve({ cwd: '/srv/ws/projects', fs }).workspace).toBe('/srv/ws');
  });

  it('prefers an explicit choice over a workspace found from here', () => {
    const fs = fakeFs('/work/.pero');
    expect(resolve({ fs, env: { PERO_HOME: '/srv/pero' } }).workspace).toBe(
      null,
    );
    expect(resolve({ fs }).workspace).toBe('/work');
  });

  it('never takes the home folder for a workspace', () => {
    const fs = fakeFs('/home/owner/.pero');
    expect(resolve({ cwd: '/home/owner/notes', fs })).toMatchObject({
      dataDir: '/home/owner/.pero',
      workspace: null,
    });
  });

  it('falls back to ~/workspace when it holds .pero/', () => {
    const fs = fakeFs('/home/owner/workspace/.pero', '/home/owner/.pero');
    expect(resolve({ fs }).workspace).toBe('/home/owner/workspace');
  });

  it('uses PERO_HOME over the default', () => {
    expect(resolve({ env: { PERO_HOME: '/srv/pero' } }).dataDir).toBe(
      '/srv/pero',
    );
  });

  it('uses --data-dir over PERO_HOME', () => {
    const config = resolve({
      dataDir: '/opt/pero',
      env: { PERO_HOME: '/srv/pero' },
    });
    expect(config.dataDir).toBe('/opt/pero');
  });

  it('resolves relative paths against cwd and expands ~', () => {
    expect(resolve({ dataDir: 'data/../pero' }).dataDir).toBe('/work/pero');
    expect(resolve({ env: { PERO_HOME: '~/alt' } }).dataDir).toBe(
      '/home/owner/alt',
    );
    expect(resolve({ dataDir: '~' }).dataDir).toBe('/home/owner');
  });

  it('normalizes absolute paths and trims whitespace', () => {
    expect(resolve({ dataDir: ' /srv//pero/ ' }).dataDir).toBe('/srv/pero');
  });

  it('reads the log level from the environment', () => {
    const config = resolve({ env: { PERO_LOG_LEVEL: 'debug' } });
    expect(config.logLevel).toBe('debug');
  });

  it.each([
    [{ dataDir: '' }, '--data-dir: must not be empty'],
    [{ dataDir: '   ' }, '--data-dir: must not be empty'],
    [{ env: { PERO_HOME: '' } }, 'PERO_HOME: must not be empty'],
    [{ workspace: ' ' }, '--workspace: must not be empty'],
    [{ env: { PERO_WORKSPACE: '' } }, 'PERO_WORKSPACE: must not be empty'],
    [{ env: { PERO_HOME: 'a\0b' } }, 'PERO_HOME: must not contain a NUL byte'],
    [
      { env: { PERO_LOG_LEVEL: 'loud' } },
      'PERO_LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace',
    ],
  ] satisfies [BootstrapConfigInput, string][])(
    'rejects %j with a clear error',
    (input, message) => {
      expect(() => resolve(input)).toThrow(ConfigError);
      expect(() => resolve(input)).toThrow(message);
    },
  );

  it('rejects an invalid option even when a valid fallback exists', () => {
    expect(() =>
      resolve({ dataDir: '', env: { PERO_HOME: '/srv/pero' } }),
    ).toThrow('--data-dir: must not be empty');
  });

  it('reports every invalid value at once', () => {
    expect(() =>
      resolve({ env: { PERO_HOME: '', PERO_LOG_LEVEL: 'loud' } }),
    ).toThrow(
      'Invalid configuration:\n' +
        '  PERO_HOME: must not be empty\n' +
        '  PERO_LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace',
    );
  });
});

describe('workspace discovery on disk', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-discovery-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const resolveIn = (input: BootstrapConfigInput) =>
    resolveBootstrapConfig({ env: {}, homeDir: join(tmp, 'home'), ...input });

  it('finds a workspace inside a Git repository, not the repository', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'pero', '.pero'), { recursive: true });
    mkdirSync(join(repo, 'pero', 'data', 'Notes'), { recursive: true });

    expect(resolveIn({ cwd: join(repo, 'pero', 'data', 'Notes') })).toEqual({
      dataDir: join(repo, 'pero', '.pero'),
      workspace: join(repo, 'pero'),
      logLevel: 'info',
    });
  });

  it('keeps searching past a Git repository without .pero/', () => {
    mkdirSync(join(tmp, 'ws', '.pero'), { recursive: true });
    mkdirSync(join(tmp, 'ws', 'projects', 'site', '.git'), {
      recursive: true,
    });

    expect(
      resolveIn({ cwd: join(tmp, 'ws', 'projects', 'site') }).workspace,
    ).toBe(join(tmp, 'ws'));
  });

  it('identifies a symlinked workspace by its real path', () => {
    mkdirSync(join(tmp, 'real', '.pero'), { recursive: true });
    symlinkSync(join(tmp, 'real'), join(tmp, 'link'));

    expect(resolveIn({ workspace: join(tmp, 'link') }).workspace).toBe(
      join(tmp, 'real'),
    );
    expect(resolveIn({ workspace: join(tmp, 'link', 'new') }).workspace).toBe(
      join(tmp, 'real', 'new'),
    );
  });

  it('skips the .pero of a home folder reached through a symlink', () => {
    mkdirSync(join(tmp, 'var-home', '.pero'), { recursive: true });
    mkdirSync(join(tmp, 'var-home', 'notes'));
    symlinkSync(join(tmp, 'var-home'), join(tmp, 'home'));

    expect(resolveIn({ cwd: join(tmp, 'var-home', 'notes') })).toMatchObject({
      dataDir: join(tmp, 'home', '.pero'),
      workspace: null,
    });
  });
});
