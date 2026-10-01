/** Signals that end `pero run` during setup, with their numbers. */
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

export interface AbortGuard {
  /** Runs the guarded stop, once however often it is called. */
  stop(): Promise<string>;
  /**
   * True once the process is on its way out: the guard exits it when the
   * stop is done, so what still runs should report nothing.
   */
  readonly ending: boolean;
  /** Stops listening; setup finished. */
  release(): void;
}

/**
 * Runs `stop` when this process is told to end, by Ctrl-C outside a
 * prompt, a closed terminal or connection, or `kill`, then prints what it
 * returns, unless the terminal is gone, and exits as that signal would.
 * An uncaught error, such as the one Node.js throws when the terminal
 * closes under a prompt, stops too, exiting 1. Until released, neither
 * ends the process at once.
 */
export function stopOnAbort(stop: () => Promise<string>): AbortGuard {
  let stopping: Promise<string> | null = null;
  let ending = false;
  const once = () => (stopping ??= stop());
  const end = (report: (message: string) => string | null, code: number) => {
    ending = true;
    void once()
      .then(
        (message) => {
          const text = report(message);
          if (text !== null) process.stderr.write(text);
        },
        // Nothing more can be done on the way out.
        () => undefined,
      )
      .finally(() => process.exit(code));
  };

  const signals = Object.entries(SIGNALS).map(([signal, number]) => {
    const listener = () =>
      end(
        (message) => (signal === 'SIGHUP' ? null : `\n${message}\n`),
        128 + number,
      );
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  const crash = (error: Error) =>
    end((message) => `\n${error.stack ?? String(error)}\n${message}\n`, 1);
  process.on('uncaughtException', crash);
  return {
    stop: once,
    get ending() {
      return ending;
    },
    release: () => {
      for (const [signal, listener] of signals) process.off(signal, listener);
      process.off('uncaughtException', crash);
    },
  };
}
