import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createControlClient } from './client.js';
import type { StatusResult } from './protocol.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** What a ready daemon records about itself in `run/`. */
export const daemonMetadataSchema = z.object({
  pid: z.int().positive(),
  version: z.string(),
  dataDir: z.string(),
  /** The workspace; null for a legacy data directory, absent before 0.2. */
  workspace: z.string().nullable().optional(),
  /** The control socket to reach it on. */
  socket: z.string(),
  /** When it became ready. */
  startedAt: z.iso.datetime(),
});

export type DaemonMetadata = z.infer<typeof daemonMetadataSchema>;

/** Writes `metadata` owner-only, replacing any earlier file in one step. */
export function writeDaemonMetadata(
  path: string,
  metadata: DaemonMetadata,
): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function removeDaemonMetadata(path: string): void {
  rmSync(path, { force: true });
}

/**
 * The recorded metadata, or null when the file is missing or unreadable.
 * It may be left over from a crash; see `findRunningDaemon`.
 */
export function readDaemonMetadata(path: string): DaemonMetadata | null {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const metadata = daemonMetadataSchema.safeParse(json);
  return metadata.success ? metadata.data : null;
}

export interface RunningDaemon {
  metadata: DaemonMetadata;
  status: StatusResult;
}

/**
 * The daemon that `path` describes, if it is still running. A pid alone may
 * be stale or reused, so the metadata counts only when its control socket
 * answers with the same pid.
 */
export async function findRunningDaemon(
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<RunningDaemon | null> {
  const metadata = readDaemonMetadata(path);
  if (!metadata) return null;
  try {
    const status = await createControlClient(metadata.socket, options).status();
    return status.pid === metadata.pid ? { metadata, status } : null;
  } catch {
    return null;
  }
}
