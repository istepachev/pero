import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Routes Nest's logger calls, including framework messages, to Pino. */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  // Nest passes `(message, ...params, context?)`, and `error` may carry a
  // stack trace before the context.
  private write(level: Level, message: unknown, params: unknown[]): void {
    const fields: Record<string, unknown> = {};
    const rest = [...params];
    const last = rest.at(-1);
    if (typeof last === 'string' && !isStack(last)) {
      fields.context = rest.pop();
    }
    for (const param of rest) {
      if (param instanceof Error) fields.err = param;
      else if (isStack(param)) fields.stack = param;
      else if (param !== undefined) {
        ((fields.params ??= []) as unknown[]).push(param);
      }
    }

    if (message instanceof Error) {
      this.logger[level]({ err: message, ...fields }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...message, ...fields });
    } else {
      this.logger[level](fields, String(message));
    }
  }
}

function isStack(value: unknown): value is string {
  return typeof value === 'string' && /\n\s+at /.test(value);
}
