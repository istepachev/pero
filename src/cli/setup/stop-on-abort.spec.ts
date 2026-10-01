import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopOnAbort } from './stop-on-abort.js';

describe('stopOnAbort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops once, reports it, and exits as the signal would', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stop = vi.fn(() => Promise.resolve('Pero was stopped.'));
    const guard = stopOnAbort(stop);
    expect(guard.ending).toBe(false);
    try {
      process.emit('SIGINT');
      expect(guard.ending).toBe(true);
      await expect(guard.stop()).resolves.toBe('Pero was stopped.');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    } finally {
      guard.release();
    }

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith('\nPero was stopped.\n');
  });

  it('says nothing once the terminal is gone', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const guard = stopOnAbort(() => Promise.resolve('Pero was stopped.'));
    try {
      process.emit('SIGHUP');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(129));
    } finally {
      guard.release();
    }

    expect(stderr).not.toHaveBeenCalled();
  });

  it('stops listening once released', () => {
    const before = process.listenerCount('SIGTERM');
    const crashes = process.listenerCount('uncaughtException');
    const guard = stopOnAbort(() => Promise.resolve(''));
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    expect(process.listenerCount('uncaughtException')).toBe(crashes + 1);

    guard.release();

    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(process.listenerCount('uncaughtException')).toBe(crashes);
  });
});
