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
  NoWorkspaceError,
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

/** Resolves from `/work`, the only workspace on the machine. */
function resolve(input: BootstrapConfigInput = {}) {
  return resolveBootstrapConfig({
    env: {},
    cwd,
    homeDir: home,
    fs: fakeFs('/work/.pero'),
    ...input,
  });
}

describe('resolveBootstrapConfig', () => {
  it('asks for pero init when no workspace is found', () => {
    const none = (dir: string) => () => resolve({ cwd: dir, fs: fakeFs() });

    expect(none('/work/notes')).toThrow(NoWorkspaceError);
    expect(none('/work/notes')).toThrow(
      'No Pero workspace found in this folder or above it, or in ~/workspace. Create one with: pero init /work/notes',
    );
    // The home folder can't be one, so ~/workspace is suggested there.
    try {
      none(home)();
    } catch (error) {
      expect((error as NoWorkspaceError).suggested).toBe(
        '/home/owner/workspace',
      );
    }
    expect.assertions(3);
  });

  it('uses --workspace, keeping state in its .pero, and info logs', () => {
    expect(resolve({ workspace: '~/notes' })).toEqual({
      workspace: '/home/owner/notes',
      stateDir: '/home/owner/notes/.pero',
      logLevel: 'info',
    });
  });

  it('prefers --workspace, then PERO_WORKSPACE', () => {
    const env = { PERO_WORKSPACE: '/srv/ws' };
    expect(resolve({ env, workspace: 'here' }).workspace).toBe('/work/here');
    expect(resolve({ env }).workspace).toBe('/srv/ws');
  });

  it('ignores PERO_HOME', () => {
    const fs = fakeFs('/home/owner/.pero', '/srv/pero');
    expect(() => resolve({ fs, env: { PERO_HOME: '/srv/pero' } })).toThrow(
      NoWorkspaceError,
    );
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
    expect(resolve({ fs, env: { PERO_WORKSPACE: '/ws' } }).workspace).toBe(
      '/ws',
    );
    expect(resolve({ fs }).workspace).toBe('/work');
  });

  it('never takes the home folder for a workspace', () => {
    const fs = fakeFs('/home/owner/.pero');
    expect(() => resolve({ cwd: '/home/owner/notes', fs })).toThrow(
      NoWorkspaceError,
    );
  });

  it('falls back to ~/workspace when it holds .pero/', () => {
    const fs = fakeFs('/home/owner/workspace/.pero', '/home/owner/.pero');
    expect(resolve({ fs }).workspace).toBe('/home/owner/workspace');
  });

  it('resolves relative paths against cwd and expands ~', () => {
    expect(resolve({ workspace: 'data/../ws' }).workspace).toBe('/work/ws');
    expect(resolve({ env: { PERO_WORKSPACE: '~/alt' } }).workspace).toBe(
      '/home/owner/alt',
    );
  });

  it('normalizes absolute paths and trims whitespace', () => {
    expect(resolve({ workspace: ' /srv//ws/ ' }).stateDir).toBe(
      '/srv/ws/.pero',
    );
  });

  it('reads the log level from the environment', () => {
    expect(resolve({ env: { PERO_LOG_LEVEL: 'debug' } })).toEqual({
      workspace: '/work',
      stateDir: '/work/.pero',
      logLevel: 'debug',
    });
  });

  it.each([
    [{ workspace: '' }, '--workspace: must not be empty'],
    [{ workspace: ' ' }, '--workspace: must not be empty'],
    [{ env: { PERO_WORKSPACE: '' } }, 'PERO_WORKSPACE: must not be empty'],
    [
      { env: { PERO_WORKSPACE: 'a\0b' } },
      'PERO_WORKSPACE: must not contain a NUL byte',
    ],
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
      resolve({ workspace: '', env: { PERO_WORKSPACE: '/ws' } }),
    ).toThrow('--workspace: must not be empty');
  });

  it('reports every invalid value at once', () => {
    expect(() =>
      resolve({ env: { PERO_WORKSPACE: '', PERO_LOG_LEVEL: 'loud' } }),
    ).toThrow(
      'Invalid configuration:\n' +
        '  PERO_WORKSPACE: must not be empty\n' +
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
      workspace: join(repo, 'pero'),
      stateDir: join(repo, 'pero', '.pero'),
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

    expect(() => resolveIn({ cwd: join(tmp, 'var-home', 'notes') })).toThrow(
      NoWorkspaceError,
    );
  });
});
