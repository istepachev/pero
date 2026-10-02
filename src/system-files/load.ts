import type { HostConfig } from '../config/host-config.js';
import {
  resolveDataFolder,
  resolveSystemFolder,
} from '../config/host-config.js';
import { readNotes, scanSystemFolder } from './scan.js';
import {
  buildSnapshot,
  type SystemSnapshot,
  type TopicLookup,
} from './snapshot.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

export interface LoadSystemFolderInput {
  /** Absolute path of the workspace. */
  workspace: string;
  /** Its `config.yaml`, which says where the data and system folders are. */
  config: Pick<HostConfig, 'data' | 'system'>;
  homeDir: string;
  /** For `Pero.md` without a `timezone`. */
  hostTimeZone: string;
  /** Without one, Channel references are checked for syntax only. */
  topics?: TopicLookup;
}

export interface LoadedSystemFolder {
  /** Absolute. */
  dataFolder: string;
  /** Absolute. */
  systemFolder: string;
  snapshot: SystemSnapshot;
}

/** Reads every note in `workspace`'s system folder into a snapshot. */
export async function loadSystemFolder(
  input: LoadSystemFolderInput,
): Promise<LoadedSystemFolder> {
  const { workspace, config, homeDir } = input;
  const dataFolder = resolveDataFolder(config, workspace, homeDir);
  const systemFolder = resolveSystemFolder(config, workspace, homeDir);
  const notes = await readNotes(
    systemFolder,
    await scanSystemFolder(systemFolder),
  );
  const snapshot = buildSnapshot(notes, {
    workspace,
    homeDir,
    hostTimeZone: input.hostTimeZone,
    ...(input.topics === undefined ? {} : { topics: input.topics }),
  });
  return { dataFolder, systemFolder, snapshot };
}
