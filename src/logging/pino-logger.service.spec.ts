import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { PinoLoggerService } from './pino-logger.service.js';

describe('PinoLoggerService', () => {
  let entries: Record<string, unknown>[];
  let service: PinoLoggerService;

  beforeEach(() => {
    entries = [];
    const stream = {
      write: (line: string) => entries.push(JSON.parse(line)),
    };
    service = new PinoLoggerService(pino({ level: 'trace' }, stream));
  });

  it('maps Nest levels to Pino levels', () => {
    service.verbose('v');
    service.debug('d');
    service.log('l');
    service.warn('w');
    service.error('e');
    service.fatal('f');

    expect(entries.map((entry) => entry.level)).toEqual([
      10, 20, 30, 40, 50, 60,
    ]);
  });

  it('records the trailing context argument', () => {
    service.log('Nest application successfully started', 'NestApplication');

    expect(entries[0]).toMatchObject({
      msg: 'Nest application successfully started',
      context: 'NestApplication',
    });
  });

  it('separates a stack trace from the context', () => {
    const stack = 'Error: boom\n    at main (main.js:1:1)';
    service.error('boom', stack, 'ExceptionsHandler');
    service.error('bare', stack);

    expect(entries[0]).toMatchObject({
      msg: 'boom',
      stack,
      context: 'ExceptionsHandler',
    });
    expect(entries[1]).toMatchObject({ msg: 'bare', stack });
    expect(entries[1]).not.toHaveProperty('context');
  });

  it('serializes errors and merges object messages', () => {
    service.error(new Error('failed'), 'Bootstrap');
    service.log({ msg: 'structured', runId: 'r1' }, 'Workflows');

    expect(entries[0]).toMatchObject({
      msg: 'failed',
      context: 'Bootstrap',
      err: { type: 'Error', message: 'failed' },
    });
    expect(entries[1]).toMatchObject({
      msg: 'structured',
      runId: 'r1',
      context: 'Workflows',
    });
  });
});
