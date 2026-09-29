import type { HostConfig } from '../config/host-config.js';
import {
  resolveDataFolder,
  resolveSettingsFolder,
} from '../config/host-config.js';
import { readNotes, scanSettingsFolder } from './scan.js';
import {
  buildSnapshot,
  type SettingsSnapshot,
  type TopicLookup,
} from './snapshot.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

export interface LoadSettingsInput {
  /** Absolute path of the workspace. */
  workspace: string;
  /** Its `config.yaml`, which says where the data and settings folders are. */
  config: Pick<HostConfig, 'data' | 'settings'>;
  homeDir: string;
  /** For `Pero.md` without a `timezone`. */
  hostTimeZone: string;
  /** Without one, Channel references are checked for syntax only. */
  topics?: TopicLookup;
}

export interface LoadedSettings {
  /** Absolute. */
  dataFolder: string;
  /** Absolute. */
  settingsFolder: string;
  snapshot: SettingsSnapshot;
}

/** Reads every note in `workspace`'s settings folder into a snapshot. */
export async function loadSettings(
  input: LoadSettingsInput,
): Promise<LoadedSettings> {
  const { workspace, config, homeDir } = input;
  const dataFolder = resolveDataFolder(config, workspace, true, homeDir)!;
  const settingsFolder = resolveSettingsFolder(config, workspace, homeDir);
  const notes = await readNotes(
    settingsFolder,
    await scanSettingsFolder(settingsFolder),
  );
  const snapshot = buildSnapshot(notes, {
    workspace,
    dataFolder,
    homeDir,
    hostTimeZone: input.hostTimeZone,
    ...(input.topics === undefined ? {} : { topics: input.topics }),
  });
  return { dataFolder, settingsFolder, snapshot };
}
