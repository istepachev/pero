import { ensureGitignoreLine, setEnvValue } from './env-file.js';
import { TELEGRAM_TOKEN_ENV } from './settings-input.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** The workspace's files that storing the bot token writes. */
export interface TokenFiles {
  /** The workspace's `.env`, which holds the token. */
  envFile: string;
  /** The workspace's `.gitignore`, made to list `.env`. */
  gitignore: string;
}

/**
 * Writes `token`, already validated, to `.env`, owner-only and keeping its
 * other lines, and adds `.env` to `.gitignore` unless it lists it. True
 * when it added that line.
 */
export function storeTelegramToken(files: TokenFiles, token: string): boolean {
  setEnvValue(files.envFile, TELEGRAM_TOKEN_ENV, token);
  return ensureGitignoreLine(files.gitignore, '.env');
}
