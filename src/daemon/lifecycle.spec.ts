import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../persistence/entities/settings.entity.js';
import { DaemonLifecycle, type DaemonLifecycleOptions } from './lifecycle.js';

describe('DaemonLifecycle', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const steps: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    steps.length = 0;
  });

  function lifecycle(options: Partial<DaemonLifecycleOptions> = {}) {
    return new DaemonLifecycle({
      close: () => {
        steps.push('close');
        return Promise.resolve();
      },
      shutdownTimeoutMs: () => Promise.resolve(1000),
      cleanup: () => steps.push('cleanup'),
      logger,
      closeMarginMs: 100,
      ...options,
    });
  }

  it('closes, then cleans up, once for concurrent requests', async () => {
    const daemon = lifecycle();

    const results = await Promise.all([
      daemon.stop('shutdown request'),
      daemon.stop('SIGTERM'),
    ]);

    expect(results).toEqual([{ graceful: true }, { graceful: true }]);
    await expect(daemon.stopped).resolves.toEqual({ graceful: true });
    expect(steps).toEqual(['close', 'cleanup']);
    expect(logger.info).toHaveBeenCalledWith(
      { reason: 'shutdown request' },
      'Pero daemon stopping',
    );
    expect(logger.info).toHaveBeenLastCalledWith('Pero daemon stopped');
  });

  it('gives up at the deadline and still cleans up', async () => {
    vi.useFakeTimers();
    const daemon = lifecycle({ close: () => new Promise(() => undefined) });

    const result = daemon.stop('SIGTERM');
    await vi.advanceTimersByTimeAsync(1099);
    expect(steps).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ graceful: false });
    expect(steps).toEqual(['cleanup']);
    expect(logger.error).toHaveBeenCalledWith(
      { deadlineMs: 1100 },
      'Pero daemon did not stop within 1100 ms; exiting anyway',
    );
  });

  it('cleans up after a failed close', async () => {
    const failure = new Error('close failed');
    const daemon = lifecycle({ close: () => Promise.reject(failure) });

    await expect(daemon.stop('SIGINT')).resolves.toEqual({ graceful: false });

    expect(steps).toEqual(['cleanup']);
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure },
      'Pero daemon failed to shut down cleanly',
    );
  });

  it('falls back to the default timeout when settings cannot be read', async () => {
    vi.useFakeTimers();
    const daemon = lifecycle({
      close: () => new Promise(() => undefined),
      shutdownTimeoutMs: () => Promise.reject(new Error('database closed')),
    });

    const result = daemon.stop('SIGTERM');
    await vi.advanceTimersByTimeAsync(DEFAULT_SHUTDOWN_TIMEOUT_MS + 99);
    expect(steps).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ graceful: false });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
