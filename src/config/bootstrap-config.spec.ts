import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  resolveBootstrapConfig,
  type BootstrapConfigInput,
} from './bootstrap-config.js';

const home = '/home/owner';
const cwd = '/work';

function resolve(input: BootstrapConfigInput = {}) {
  return resolveBootstrapConfig({ env: {}, cwd, homeDir: home, ...input });
}

describe('resolveBootstrapConfig', () => {
  it('defaults to ~/.pero and info logs', () => {
    expect(resolve()).toEqual({
      dataDir: '/home/owner/.pero',
      logLevel: 'info',
    });
  });

  it('uses PERO_HOME over the default', () => {
    expect(resolve({ env: { PERO_HOME: '/srv/pero' } }).dataDir).toBe(
      '/srv/pero',
    );
  });

  it('uses --data-dir over PERO_HOME', () => {
    const config = resolve({
      dataDir: '/opt/pero',
      env: { PERO_HOME: '/srv/pero' },
    });
    expect(config.dataDir).toBe('/opt/pero');
  });

  it('resolves relative paths against cwd and expands ~', () => {
    expect(resolve({ dataDir: 'data/../pero' }).dataDir).toBe('/work/pero');
    expect(resolve({ env: { PERO_HOME: '~/alt' } }).dataDir).toBe(
      '/home/owner/alt',
    );
    expect(resolve({ dataDir: '~' }).dataDir).toBe('/home/owner');
  });

  it('normalizes absolute paths and trims whitespace', () => {
    expect(resolve({ dataDir: ' /srv//pero/ ' }).dataDir).toBe('/srv/pero');
  });

  it('reads the log level from the environment', () => {
    const config = resolve({ env: { PERO_LOG_LEVEL: 'debug' } });
    expect(config.logLevel).toBe('debug');
  });

  it.each([
    [{ dataDir: '' }, '--data-dir: must not be empty'],
    [{ dataDir: '   ' }, '--data-dir: must not be empty'],
    [{ env: { PERO_HOME: '' } }, 'PERO_HOME: must not be empty'],
    [{ env: { PERO_HOME: 'a\0b' } }, 'PERO_HOME: must not contain a NUL byte'],
    [
      { env: { PERO_LOG_LEVEL: 'loud' } },
      'PERO_LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace',
    ],
  ] satisfies [BootstrapConfigInput, string][])(
    'rejects %j with a clear error',
    (input, message) => {
      expect(() => resolve(input)).toThrow(ConfigError);
      expect(() => resolve(input)).toThrow(message);
    },
  );

  it('rejects an invalid option even when a valid fallback exists', () => {
    expect(() =>
      resolve({ dataDir: '', env: { PERO_HOME: '/srv/pero' } }),
    ).toThrow('--data-dir: must not be empty');
  });

  it('reports every invalid value at once', () => {
    expect(() =>
      resolve({ env: { PERO_HOME: '', PERO_LOG_LEVEL: 'loud' } }),
    ).toThrow(
      'Invalid configuration:\n' +
        '  PERO_HOME: must not be empty\n' +
        '  PERO_LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace',
    );
  });
});
