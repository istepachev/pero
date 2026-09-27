import pino, { type Logger, type StreamEntry } from 'pino';
import type { LogLevel } from '../config/bootstrap-config.js';

/**
 * Field names whose values never reach a log line, at the top level or one
 * level down (for example `headers.authorization`).
 */
export const REDACTED_KEYS = [
  'token',
  'botToken',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authorization',
  'cookie',
  'password',
  'secret',
  'prompt',
  'toolOutput',
] as const;

export interface LoggerOptions {
  level: LogLevel;
  /** JSON lines are appended to this file, created owner-only. */
  file: string;
  /** Also write JSON lines to stdout, for foreground runs. */
  stdout: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  const { level } = options;
  const streams: StreamEntry<LogLevel>[] = [
    {
      level,
      stream: pino.destination({ dest: options.file, mode: 0o600, sync: true }),
    },
  ];
  if (options.stdout) {
    streams.push({ level, stream: pino.destination({ dest: 1, sync: true }) });
  }

  return pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]),
        censor: '[Redacted]',
      },
    },
    pino.multistream(streams),
  );
}
