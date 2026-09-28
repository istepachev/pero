import { z } from 'zod';
import { ConfigError } from './bootstrap-config.js';

// Daemon-only settings from its environment. Keep this free of Nest imports.

/** Where the Telegram adapter reaches the Bot API, such as a local server. */
export const TELEGRAM_API_ROOT_ENV = 'PERO_TELEGRAM_API_ROOT';

/**
 * For testing only: `echo` gives both providers a runtime that answers
 * `echo: <message>`, so a real bot can be tried without an agent SDK.
 */
export const FAKE_RUNTIME_ENV = 'PERO_FAKE_RUNTIME';

export interface DaemonEnv {
  /** The Bot API root, without a trailing slash; unset for Telegram's own. */
  telegramApiRoot?: string;
  fakeRuntime?: 'echo';
}

const sources = z.object({
  [TELEGRAM_API_ROOT_ENV]: z
    .url({ protocol: /^https?$/, error: 'must be an http or https URL' })
    .transform((url) => url.replace(/\/+$/, ''))
    .optional(),
  [FAKE_RUNTIME_ENV]: z
    .enum(['echo'], { error: 'must be echo when set' })
    .optional(),
});

/** Reads the daemon's own settings from `env`; empty values count as unset. */
export function resolveDaemonEnv(env: NodeJS.ProcessEnv): DaemonEnv {
  const value = (name: string) => env[name]?.trim() || undefined;
  const parsed = sources.safeParse({
    [TELEGRAM_API_ROOT_ENV]: value(TELEGRAM_API_ROOT_ENV),
    [FAKE_RUNTIME_ENV]: value(FAKE_RUNTIME_ENV),
  });
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const {
    [TELEGRAM_API_ROOT_ENV]: telegramApiRoot,
    [FAKE_RUNTIME_ENV]: fakeRuntime,
  } = parsed.data;
  return {
    ...(telegramApiRoot ? { telegramApiRoot } : {}),
    ...(fakeRuntime ? { fakeRuntime } : {}),
  };
}
