import { describe, expect, it } from 'vitest';
import { ConfigError } from './bootstrap-config.js';
import { resolveDaemonEnv } from './daemon-env.js';

describe('resolveDaemonEnv', () => {
  it('is empty by default', () => {
    expect(resolveDaemonEnv({})).toEqual({});
    expect(
      resolveDaemonEnv({ PERO_TELEGRAM_API_ROOT: ' ', PERO_FAKE_RUNTIME: '' }),
    ).toEqual({});
  });

  it('reads the Bot API root without a trailing slash', () => {
    expect(
      resolveDaemonEnv({ PERO_TELEGRAM_API_ROOT: 'http://127.0.0.1:8081/' }),
    ).toEqual({ telegramApiRoot: 'http://127.0.0.1:8081' });
  });

  it('reads the echo runtime switch', () => {
    expect(resolveDaemonEnv({ PERO_FAKE_RUNTIME: 'echo' })).toEqual({
      fakeRuntime: 'echo',
    });
  });

  it('names each invalid value', () => {
    expect(() =>
      resolveDaemonEnv({
        PERO_TELEGRAM_API_ROOT: 'ftp://example.com',
        PERO_FAKE_RUNTIME: 'claude',
      }),
    ).toThrow(
      new ConfigError(
        'Invalid configuration:\n' +
          '  PERO_TELEGRAM_API_ROOT: must be an http or https URL\n' +
          '  PERO_FAKE_RUNTIME: must be echo when set',
      ),
    );
  });
});
