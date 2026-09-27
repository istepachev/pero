import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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

export const DEFAULT_DATA_DIR_NAME = '.pero';
export const DEFAULT_PORT = 7717;

/** Settings the process needs before it can open the data directory. */
export interface BootstrapConfig {
  /** Absolute path of the data directory. */
  dataDir: string;
  logLevel: LogLevel;
  /** Loopback HTTP port; 0 picks a free port. */
  port: number;
}

export interface BootstrapConfigInput {
  /** Value of the `--data-dir` option, if given. */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
}

/** Raised for invalid bootstrap values; the message names each offending source. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

const path = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => !value.includes('\0'), 'must not contain a NUL byte');

// Keys are the names the owner typed, so issues can be reported verbatim.
const sources = z.object({
  '--data-dir': path.optional(),
  PERO_HOME: path.optional(),
  PERO_LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
    .optional(),
  PERO_PORT: z
    .string()
    .regex(/^\d+$/, 'must be an integer from 0 to 65535')
    .transform(Number)
    .pipe(z.number().max(65535, 'must be an integer from 0 to 65535'))
    .optional(),
});

/**
 * Resolves bootstrap configuration. The data directory comes from the
 * `--data-dir` option, then `PERO_HOME`, then `~/.pero`; a leading `~` is
 * expanded and relative paths resolve against `cwd`.
 */
export function resolveBootstrapConfig(
  input: BootstrapConfigInput = {},
): BootstrapConfig {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const home = input.homeDir ?? homedir();

  const parsed = sources.safeParse({
    '--data-dir': input.dataDir,
    PERO_HOME: env.PERO_HOME,
    PERO_LOG_LEVEL: env.PERO_LOG_LEVEL,
    PERO_PORT: env.PERO_PORT,
  });
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }

  const values = parsed.data;
  const dataDir =
    values['--data-dir'] ??
    values.PERO_HOME ??
    join(home, DEFAULT_DATA_DIR_NAME);

  return {
    dataDir: toAbsolute(dataDir, cwd, home),
    logLevel: values.PERO_LOG_LEVEL ?? 'info',
    port: values.PERO_PORT ?? DEFAULT_PORT,
  };
}

function toAbsolute(path: string, cwd: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
