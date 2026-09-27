import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-logger-'));
    file = join(tmp, 'pero.log');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const lines = () =>
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('appends JSON lines to an owner-only file', () => {
    const logger = createLogger({ level: 'info', file, stdout: false });
    logger.info({ agentId: 'a1' }, 'first');
    logger.debug('filtered by level');
    createLogger({ level: 'info', file, stdout: false }).warn('second');

    expect(lines()).toMatchObject([
      { level: 30, msg: 'first', agentId: 'a1' },
      { level: 40, msg: 'second' },
    ]);
    expect(lines()[0].time).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('redacts secrets at the top level and one level down', () => {
    const logger = createLogger({ level: 'info', file, stdout: false });
    logger.info(
      {
        token: 'bot:123',
        headers: { authorization: 'Bearer x', accept: 'json' },
        run: { prompt: 'private', status: 'ok' },
      },
      'request',
    );

    expect(lines()[0]).toMatchObject({
      token: '[Redacted]',
      headers: { authorization: '[Redacted]', accept: 'json' },
      run: { prompt: '[Redacted]', status: 'ok' },
    });
    expect(readFileSync(file, 'utf8')).not.toMatch(/bot:123|Bearer x|private/);
  });
});
