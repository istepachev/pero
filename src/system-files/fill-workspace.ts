import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ConfigError } from '../config/bootstrap-config.js';
import { ensureGitignoreLine } from '../config/env-file.js';
import {
  DEFAULT_DATA_FOLDER,
  defaultHostConfig,
  type HostConfig,
  readHostConfig,
  resolveDataFolder,
  resolveSystemFolder,
} from '../config/host-config.js';
import { ensureWorkspaceLayout } from '../config/workspace-layout.js';
import {
  peroNote,
  SKELETON_NOTES,
  type SkeletonEntry,
  writeIfMissing,
} from '../config/workspace-skeleton.js';
import { NOTE_FOLDERS, noteIdentity, PERO_NOTE } from './note-files.js';
import { createFileExclusive } from './note-writer.js';
import { scanSystemFolder } from './scan.js';
import { DEFAULT_NOTE, DEFAULT_NOTE_FILE } from './snapshot.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * Fills in what `workspace` is missing of what Pero needs, never changing
 * a file that is there: `.env` in its `.gitignore`, `.pero/` with its
 * `.gitignore` and `config.yaml`, the default data folder `data/`, and in
 * the system folder `Pero.md`, `Persona.md`, `Instructions.md`,
 * `Workflows/`, and `Channels/Default.md`, unless a note of that name is
 * anywhere under `Channels/`. Returns what it created or updated,
 * relative to the workspace.
 *
 * A data folder `config.yaml` names other than `data/` is not created, as
 * it may be a vault not mounted yet, and while it is missing neither is the
 * system folder; startup reports it. With an invalid `config.yaml`, the
 * parts that depend on it are left to `pero check` to report.
 */
export async function fillWorkspace(
  workspace: string,
  home?: string,
): Promise<SkeletonEntry[]> {
  const entries: SkeletonEntry[] = [];
  const shown = (path: string) => {
    const inside = relative(workspace, path);
    return inside.startsWith('..') ? path : inside;
  };
  const file = (path: string, text: string) => {
    if (writeIfMissing(path, text)) {
      entries.push({ path: shown(path), action: 'created' });
    }
  };
  const folder = (path: string) => {
    if (mkdirSync(path, { recursive: true }) !== undefined) {
      entries.push({ path: `${shown(path)}/`, action: 'created' });
    }
  };

  const layout = ensureWorkspaceLayout(workspace);
  const gitignore = layout.workspaceGitignore;
  const hadGitignore = readText(gitignore) !== null;
  if (ensureGitignoreLine(gitignore, '.env')) {
    entries.push({
      path: '.gitignore',
      action: hadGitignore ? 'updated' : 'created',
    });
  }
  file(layout.configFile, defaultHostConfig());

  let config: HostConfig;
  try {
    config = readHostConfig(layout.configFile)!;
  } catch (error) {
    if (error instanceof ConfigError) return entries;
    throw error;
  }
  const data = resolveDataFolder(config, workspace, home);
  if (data === join(workspace, DEFAULT_DATA_FOLDER)) folder(data);
  if (!existsSync(data)) return entries;

  const system = resolveSystemFolder(config, workspace, home);
  file(
    join(system, PERO_NOTE),
    peroNote(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  folder(join(system, NOTE_FOLDERS.workflow));
  for (const [path, text] of Object.entries(SKELETON_NOTES)) {
    if (path.startsWith(`${NOTE_FOLDERS.channel}/`)) continue;
    file(join(system, path), text);
  }
  if (!(await hasDefaultNote(system))) {
    const path = join(system, DEFAULT_NOTE_FILE);
    if (createFileExclusive(path, SKELETON_NOTES[DEFAULT_NOTE_FILE]!)) {
      entries.push({ path: shown(path), action: 'created' });
    }
  }
  return entries;
}

/** Whether any note under `Channels/` in `system` is named `default`. */
async function hasDefaultNote(system: string): Promise<boolean> {
  return (await scanSystemFolder(system)).some(({ file }) => {
    const found = noteIdentity(file);
    return (
      found.ok &&
      found.identity.kind === 'channel' &&
      found.identity.name === DEFAULT_NOTE
    );
  });
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
