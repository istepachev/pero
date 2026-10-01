import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Pero's own folder inside a workspace. */
export const STATE_DIR_NAME = '.pero';

/** The workspace tried when none is found from the current folder. */
export const DEFAULT_WORKSPACE_NAME = 'workspace';

/** Settings the process needs before it can open its state directory. */
export interface BootstrapConfig {
  /** Absolute path of the workspace. */
  workspace: string;
  /** Absolute path of its state directory, `<workspace>/.pero`. */
  stateDir: string;
  logLevel: LogLevel;
}

/** The file system questions discovery asks; replaceable in tests. */
export interface DiscoveryFs {
  isDirectory(path: string): boolean;
  /** `path` with symbolic links resolved; it exists. */
  realpath(path: string): string;
}

export interface BootstrapConfigInput {
  /** Value of the `--workspace` option, if given. */
  workspace?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  fs?: DiscoveryFs;
}

/** Raised for invalid bootstrap values; the message names each offending source. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Nothing names a workspace and none is found: Pero has nothing to work
 * on until `pero init` makes one.
 */
export class NoWorkspaceError extends ConfigError {
  override name = 'NoWorkspaceError';

  /** `dir`: where `pero init` would suit, the current folder or `~/workspace`. */
  constructor(readonly suggested: string) {
    super(
      `No Pero workspace found in this folder or above it, or in ~/workspace. Create one with: pero init ${suggested}`,
    );
  }
}

const nodeFs: DiscoveryFs = {
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  realpath: (path) => realpathSync(path),
};

const path = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => !value.includes('\0'), 'must not contain a NUL byte');

// Keys are the names the owner typed, so issues can be reported verbatim.
const sources = z.object({
  '--workspace': path.optional(),
  PERO_WORKSPACE: path.optional(),
  PERO_LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
    .optional(),
});

/**
 * Resolves bootstrap configuration. Explicit choices come first: the
 * `--workspace` option, then `PERO_WORKSPACE`. Otherwise the workspace is
 * the nearest folder holding `.pero/`, from `cwd` upward, then
 * `~/workspace` when it holds `.pero/`. The home folder itself never
 * counts, since every folder under it would resolve to it. With none of
 * them, it throws `NoWorkspaceError`.
 *
 * A leading `~` is expanded and relative paths resolve against `cwd`. A
 * workspace is identified by its real path, so a symlinked folder is the
 * same workspace.
 */
export function resolveBootstrapConfig(
  input: BootstrapConfigInput = {},
): BootstrapConfig {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const home = input.homeDir ?? homedir();
  const fs = input.fs ?? nodeFs;

  const parsed = sources.safeParse({
    '--workspace': input.workspace,
    PERO_WORKSPACE: env.PERO_WORKSPACE,
    PERO_LOG_LEVEL: env.PERO_LOG_LEVEL,
  });
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }

  const values = parsed.data;
  const logLevel = values.PERO_LOG_LEVEL ?? 'info';
  const inWorkspace = (dir: string): BootstrapConfig => {
    const workspace = canonical(resolvePath(dir, cwd, home), fs);
    return { workspace, stateDir: join(workspace, STATE_DIR_NAME), logLevel };
  };

  const named = values['--workspace'] ?? values.PERO_WORKSPACE;
  if (named !== undefined) return inWorkspace(named);

  const found = findWorkspace(resolve(cwd), home, fs);
  if (found !== null) return inWorkspace(found);
  const fallback = join(home, DEFAULT_WORKSPACE_NAME);
  if (fs.isDirectory(join(fallback, STATE_DIR_NAME))) {
    return inWorkspace(fallback);
  }
  throw new NoWorkspaceError(suggestedWorkspace(cwd, home, fs));
}

/**
 * Where to suggest a new workspace: the current folder, or `~/workspace`
 * from the home folder, which can't be one.
 */
export function suggestedWorkspace(
  cwd: string,
  home: string,
  fs: DiscoveryFs = nodeFs,
): string {
  const here = canonical(resolve(cwd), fs);
  return here === canonical(resolve(home), fs)
    ? join(home, DEFAULT_WORKSPACE_NAME)
    : here;
}

/** Whether `dir` is the home folder, which is never a workspace. */
export function isHomeFolder(
  dir: string,
  home: string = homedir(),
  fs: DiscoveryFs = nodeFs,
): boolean {
  return canonical(resolve(dir), fs) === canonical(resolve(home), fs);
}

/**
 * The nearest folder from `start` upward that holds `.pero/`, the way Git
 * finds a repository; null when there is none. The home folder is skipped.
 */
export function findWorkspace(
  start: string,
  home: string,
  fs: DiscoveryFs = nodeFs,
): string | null {
  const homes = new Set([resolve(home), canonical(resolve(home), fs)]);
  for (let dir = start; ; dir = dirname(dir)) {
    if (!homes.has(dir) && fs.isDirectory(join(dir, STATE_DIR_NAME))) {
      return dir;
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * `path` with symbolic links resolved. A path that does not exist yet keeps
 * its missing part below the nearest folder that does.
 */
function canonical(path: string, fs: DiscoveryFs): string {
  const missing: string[] = [];
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      return join(fs.realpath(dir), ...missing);
    } catch {
      if (dirname(dir) === dir) return path;
      missing.unshift(basename(dir));
    }
  }
}

/**
 * `path` as an absolute path: a leading `~` is the home directory, and a
 * relative path is taken from `cwd`.
 */
export function resolvePath(path: string, cwd: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return resolve(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
