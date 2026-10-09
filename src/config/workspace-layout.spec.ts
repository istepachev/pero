import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  controlSocketPath,
  ensureWorkspaceLayout,
  MAX_SOCKET_PATH_BYTES,
  STATE_GITIGNORE,
  StateDirError,
  workspaceLayout,
} from './workspace-layout.js';

const mode = (path: string) => statSync(path).mode & 0o777;

describe('workspaceLayout', () => {
  it('places Pero state under .pero/ and the rest in the workspace', () => {
    expect(workspaceLayout('/srv/ws')).toEqual({
      workspace: '/srv/ws',
      stateDir: '/srv/ws/.pero',
      database: '/srv/ws/.pero/pero.sqlite',
      logs: '/srv/ws/.pero/logs',
      logFile: '/srv/ws/.pero/logs/pero.log',
      daemonOutputFile: '/srv/ws/.pero/logs/daemon.out',
      run: '/srv/ws/.pero/run',
      controlSocket: '/srv/ws/.pero/run/pero.sock',
      lockFile: '/srv/ws/.pero/run/pero.lock',
      metadataFile: '/srv/ws/.pero/run/pero.json',
      models: '/srv/ws/.pero/models',
      tools: '/srv/ws/.pero/tools',
      stateGitignore: '/srv/ws/.pero/.gitignore',
      attachments: '/srv/ws/.pero/attachments',
      configFile: '/srv/ws/.pero/config.yaml',
      envFile: '/srv/ws/.env',
      workspaceGitignore: '/srv/ws/.gitignore',
    });
  });
});

describe('controlSocketPath', () => {
  it('is in run/ while that path fits a Unix socket', () => {
    expect(controlSocketPath('/srv/ws/.pero')).toBe(
      '/srv/ws/.pero/run/pero.sock',
    );
  });

  it('moves under XDG_RUNTIME_DIR, named after the folder, when too long', () => {
    const stateDir = `/srv/${'x'.repeat(MAX_SOCKET_PATH_BYTES)}/.pero`;
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    const socket = controlSocketPath(stateDir, env);

    expect(socket).toMatch(
      /^\/run\/user\/1000\/pero-[0-9a-f]{16}\/pero\.sock$/,
    );
    expect(controlSocketPath(stateDir, env)).toBe(socket);
    expect(controlSocketPath(`${stateDir}2`, env)).not.toBe(socket);
  });

  it('uses the temp folder without XDG_RUNTIME_DIR', () => {
    const stateDir = `/srv/${'x'.repeat(MAX_SOCKET_PATH_BYTES)}`;
    expect(controlSocketPath(stateDir, {})).toMatch(
      new RegExp(`^${tmpdir()}/pero-[0-9a-f]{16}/pero\\.sock$`),
    );
  });
});

describe('ensureWorkspaceLayout', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-layout-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates .pero/ and its subdirectories owner-only', () => {
    const layout = ensureWorkspaceLayout(join(tmp, 'nested', 'ws'));

    for (const dir of [layout.stateDir, layout.logs, layout.run]) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(mode(dir)).toBe(0o700);
    }
  });

  it('is idempotent and tightens existing subdirectories', () => {
    const workspace = join(tmp, 'ws');
    const layout = ensureWorkspaceLayout(workspace);
    writeFileSync(layout.logFile, 'kept\n');
    chmodSync(layout.logs, 0o755);

    ensureWorkspaceLayout(workspace);

    expect(mode(layout.logs)).toBe(0o700);
    expect(statSync(layout.logFile).size).toBe(5);
  });

  it('leaves the permissions of an existing .pero/ alone', () => {
    const workspace = join(tmp, 'ws');
    mkdirSync(join(workspace, '.pero'), { recursive: true, mode: 0o755 });

    ensureWorkspaceLayout(workspace);

    expect(mode(join(workspace, '.pero'))).toBe(0o755);
  });

  it('writes .pero/.gitignore once, keeping an edited one', () => {
    const workspace = join(tmp, 'ws');
    const layout = ensureWorkspaceLayout(workspace);

    expect(readFileSync(layout.stateGitignore, 'utf8')).toBe(STATE_GITIGNORE);
    writeFileSync(layout.stateGitignore, '*\n');
    ensureWorkspaceLayout(workspace);
    expect(readFileSync(layout.stateGitignore, 'utf8')).toBe('*\n');
  });

  it('makes no secrets/', () => {
    const layout = ensureWorkspaceLayout(join(tmp, 'ws'));
    expect(() => statSync(join(layout.stateDir, 'secrets'))).toThrow();
  });

  it('creates an owner-only folder for a relocated socket', () => {
    const workspace = join(tmp, 'y'.repeat(MAX_SOCKET_PATH_BYTES));
    const layout = ensureWorkspaceLayout(workspace);

    expect(layout.controlSocket.startsWith(layout.run)).toBe(false);
    const socketDir = join(layout.controlSocket, '..');
    try {
      expect(mode(socketDir)).toBe(0o700);
    } finally {
      rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it('explains when .pero is a file', () => {
    const workspace = join(tmp, 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, '.pero'), '');

    expect(() => ensureWorkspaceLayout(workspace)).toThrow(StateDirError);
    expect(() => ensureWorkspaceLayout(workspace)).toThrow(
      `Cannot prepare ${join(workspace, '.pero')}:`,
    );
  });
});
