import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../common/errors.js';
import { DaemonNotRunningError } from '../control/client.js';
import { CliError, reportCliError } from './errors.js';

describe('reportCliError', () => {
  const printed = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    printed.mockClear();
    process.exitCode = undefined;
  });

  it('prints only the message of an error the owner can act on', () => {
    reportCliError(new DaemonNotRunningError('/tmp/pero.sock'));

    expect(printed).toHaveBeenCalledWith(
      "Pero isn't running — start it with pero run",
    );
    expect(process.exitCode).toBe(1);
  });

  it('uses the exit code a CliError carries', () => {
    reportCliError(new CliError('Pero is stopped', 3));

    expect(printed).toHaveBeenCalledWith('Pero is stopped');
    expect(process.exitCode).toBe(3);
  });

  it('reports input errors from the daemon by message', () => {
    reportCliError(
      new InvalidInputError('timezone: must be an IANA time zone'),
    );

    expect(printed).toHaveBeenCalledWith('timezone: must be an IANA time zone');
  });

  it('prints an unexpected error in full', () => {
    const error = new TypeError('boom');

    reportCliError(error);

    expect(printed).toHaveBeenCalledWith(error);
    expect(process.exitCode).toBe(1);
  });
});
