import type { StatusResult } from '../control/protocol.js';

/**
 * `pero status` output for a running daemon. `cliVersion` is the installed
 * package; a daemon started from an older install keeps its own version.
 */
export function formatStatus(status: StatusResult, cliVersion: string): string {
  const lines = [
    'Pero is running',
    ...table([
      ['PID', String(status.pid)],
      ['Version', status.version],
      location(status),
      ['Uptime', formatDuration(status.uptimeMs)],
      ['Health', status.health],
    ]).map((row) => `  ${row}`),
  ];
  if (status.version !== cliVersion) {
    lines.push(
      '',
      `The installed version is ${cliVersion}; restart Pero to use it (pero stop, then pero run).`,
    );
  }
  if (status.components.length > 0) {
    lines.push(
      '',
      'Components',
      ...table(
        status.components.map(({ name, state, detail, required }) => [
          name,
          state,
          // Health does not depend on it, so it needs nothing now.
          !required && state !== 'ok'
            ? `${detail ?? ''} (not in use)`.trimStart()
            : (detail ?? ''),
        ]),
      ).map((row) => `  ${row}`),
    );
  }
  return lines.join('\n');
}

/** The workspace, or the data directory, marked legacy when it is one. */
function location(status: StatusResult): [string, string] {
  if (typeof status.workspace === 'string') {
    return ['Workspace', status.workspace];
  }
  // Absent: a daemon from before workspaces, where every one was legacy.
  return ['Data directory', `${status.dataDir} (legacy)`];
}

/** A short duration such as `42s`, `3m 12s`, `2h 5m`, or `3d 4h`. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const [d, h, m, s] = [
    Math.floor(seconds / 86_400),
    Math.floor(seconds / 3600) % 24,
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ];
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Left-aligned columns separated by two spaces, without trailing blanks. */
export function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths![column]!))
      .join('  ')
      .trimEnd(),
  );
}
