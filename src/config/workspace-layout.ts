import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATE_DIR_NAME } from './bootstrap-config.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

const OWNER_ONLY = 0o700;

/** sun_path is 104 bytes on macOS and the BSDs and 108 on Linux, NUL included. */
export const MAX_SOCKET_PATH_BYTES = process.platform === 'linux' ? 107 : 103;

/**
 * `.pero/.gitignore` in a workspace: everything in `.pero/` is Pero's own
 * state except `config.yaml`, which is meant to be committed.
 */
export const STATE_GITIGNORE = [
  '# Written by Pero. Everything here is its state, except config.yaml.',
  '*',
  '!.gitignore',
  '!config.yaml',
  '',
].join('\n');

/** Absolute paths of a workspace's files that Pero reads and writes. */
export interface WorkspaceLayout {
  workspace: string;
  /** `.pero/`: Pero's state. */
  stateDir: string;
  database: string;
  logs: string;
  logFile: string;
  /** Plain-text stdout and stderr of a daemon started by `pero run`. */
  daemonOutputFile: string;
  run: string;
  /**
   * Unix socket of the control endpoint; owner-only. It is in `run/` unless
   * that path is too long for a socket; see `controlSocketPath`.
   */
  controlSocket: string;
  /** Held by the running daemon; the file itself stays after it stops. */
  lockFile: string;
  /** The running daemon's pid, version, and socket; JSON. */
  metadataFile: string;
  /** `.pero/.gitignore`. */
  stateGitignore: string;
  /** The files people send in chats, one folder per Channel. */
  attachments: string;
  /** The `local` speech engine's models, as `pero speech setup` fetches them. */
  models: string;
  /** `config.yaml`: the data folder and the chats Pero serves. */
  configFile: string;
  /** The workspace's `.env`, which holds the bot token. */
  envFile: string;
  /** The workspace's own `.gitignore`. */
  workspaceGitignore: string;
}

export class StateDirError extends Error {
  override name = 'StateDirError';
}

/** Returns the layout of `workspace` without touching the filesystem. */
export function workspaceLayout(workspace: string): WorkspaceLayout {
  const stateDir = join(workspace, STATE_DIR_NAME);
  const logs = join(stateDir, 'logs');
  const run = join(stateDir, 'run');
  return {
    workspace,
    stateDir,
    database: join(stateDir, 'pero.sqlite'),
    logs,
    logFile: join(logs, 'pero.log'),
    daemonOutputFile: join(logs, 'daemon.out'),
    run,
    controlSocket: controlSocketPath(stateDir),
    lockFile: join(run, 'pero.lock'),
    metadataFile: join(run, 'pero.json'),
    stateGitignore: join(stateDir, '.gitignore'),
    attachments: join(stateDir, 'attachments'),
    models: join(stateDir, 'models'),
    configFile: join(stateDir, 'config.yaml'),
    envFile: join(workspace, '.env'),
    workspaceGitignore: join(workspace, '.gitignore'),
  };
}

/**
 * The control socket of state directory `stateDir`: `run/pero.sock`, or,
 * when that path is too long for a Unix socket, `pero.sock` in a folder
 * named after a hash of `stateDir` under `$XDG_RUNTIME_DIR` or the temp
 * folder.
 */
export function controlSocketPath(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const socket = join(stateDir, 'run', 'pero.sock');
  if (Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES) return socket;
  const hash = createHash('sha256').update(stateDir).digest('hex').slice(0, 16);
  const base = env.XDG_RUNTIME_DIR?.trim() || tmpdir();
  return join(base, `pero-${hash}`, 'pero.sock');
}

/**
 * Creates the workspace's `.pero/` and its subdirectories with owner-only
 * permissions. A `.pero/` created here is made owner-only; an existing one
 * is left alone because the owner may manage it. Pero's own subdirectories
 * are always reset to owner-only, and `.pero/.gitignore` is written when it
 * is missing.
 */
export function ensureWorkspaceLayout(workspace: string): WorkspaceLayout {
  const layout = workspaceLayout(workspace);
  const { stateDir } = layout;
  try {
    const created = mkdirSync(stateDir, { recursive: true, mode: OWNER_ONLY });
    if (created !== undefined) chmodSync(stateDir, OWNER_ONLY);
    const socketDir = dirname(layout.controlSocket);
    const dirs = [layout.logs, layout.run];
    if (socketDir !== layout.run) dirs.push(socketDir);
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true, mode: OWNER_ONLY });
      chmodSync(dir, OWNER_ONLY);
    }
    if (socketDir !== layout.run) checkOwnDirectory(socketDir);
    writeIfMissing(layout.stateGitignore, STATE_GITIGNORE);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new StateDirError(`Cannot prepare ${stateDir}: ${reason}`, {
      cause: error,
    });
  }
  return layout;
}

/** A socket folder in a shared place must belong to this user alone. */
function checkOwnDirectory(dir: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  if (statSync(dir).uid !== uid) {
    throw new Error(`${dir} belongs to another user`);
  }
}

function writeIfMissing(path: string, text: string): void {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
