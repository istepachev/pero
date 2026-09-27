// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** How long a stopping daemon waits for active work to finish. */
export const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Time allowed past the shutdown timeout for closing the control socket and
 * the database once active work has finished or been abandoned.
 */
export const CLOSE_MARGIN_MS = 5000;

/** How long a daemon may take to stop before it exits anyway. */
export const STOP_DEADLINE_MS = SHUTDOWN_TIMEOUT_MS + CLOSE_MARGIN_MS;
