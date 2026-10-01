import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { isHomeFolder, STATE_DIR_NAME } from './bootstrap-config.js';
import { STATE_GITIGNORE } from './workspace-layout.js';
import { ensureGitignoreLine } from './env-file.js';
import {
  defaultHostConfig,
  HOST_CONFIG_FILE,
  readHostConfig,
  resolveSettingsFolder,
} from './host-config.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** What `pero init` did with one path of the skeleton. */
export interface SkeletonEntry {
  /** The path, relative to the workspace when inside it. */
  path: string;
  /** `updated`: an existing `.gitignore` gained the `.env` line. */
  action: 'created' | 'updated' | 'kept';
}

/** A folder `pero init` refuses to make a workspace of. */
export class WorkspaceInitError extends Error {
  override name = 'WorkspaceInitError';
}

/**
 * `Pero.md` as `pero init` writes it, with `timeZone`, the host's, set so
 * the owner sees the zone schedules use and can change it.
 */
export function peroNote(timeZone: string): string {
  const timezone = `timezone: ${timeZone}`;
  return `---
# Installation defaults: each applies to every Agent and Workflow that
# doesn't set its own. Remove the # in front of a line to change it.
# Instructions go in the Agents' notes, not here.
# provider: claude            # claude or codex
# claude-model: opus
# claude-effort: high
# codex-model: gpt-5.5
# permissions: ask            # ask or bypass
${timezone.padEnd(29)} # this server's; set yours, such as Europe/Berlin
# main-agent: Main            # the Agent note for General topics and direct chats
# history-carryover: 50
# history-retention-days: 90  # keep everything when not set
# max-concurrent-runs: 2
---
`;
}

const MAIN_NOTE = `---
# The main Agent: it answers the General topic of every allowed group,
# groups without topics, and direct chats. Every topic's Agent starts
# with these instructions, then adds its own.
# Remove the # to change a line.
# provider: claude
# model: sonnet
# effort: high
# permissions: ask
# working-directory: projects/site   # relative to the workspace
---
You are a calm, concise personal assistant. Reply in the language you're written to in.
You help with everyday questions and keep my notes tidy.
`;

/**
 * The notes `pero init` writes as they are, by their path in the settings
 * folder; `Pero.md`, which holds the host's time zone, is `peroNote`'s.
 */
export const SKELETON_NOTES: Readonly<Record<string, string>> = {
  'Agents/Main.md': MAIN_NOTE,
};

/**
 * Makes `dir` a workspace, writing what is missing of the skeleton and
 * never overwriting a file: `.gitignore` listing `.env`, `.pero/` with its
 * `.gitignore` and a commented `config.yaml` naming `data` as the data
 * folder (`data/` by default), and in the settings folder `Pero.md`,
 * `Agents/Main.md`, and `Workflows/`.
 * In a cloned workspace it only fills in what is missing, and an existing
 * `config.yaml` decides where the settings folder is.
 */
export function initWorkspace(
  dir: string,
  home?: string,
  data?: string,
): { workspace: string; entries: SkeletonEntry[] } {
  if (isHomeFolder(dir, home)) {
    throw new WorkspaceInitError(
      `${dir} is your home folder, which can't be a workspace: every folder under it would find it. Use a folder of its own, such as ~/workspace.`,
    );
  }
  const entries: SkeletonEntry[] = [];
  const shown = (path: string) => {
    const inside = relative(dir, path);
    return inside.startsWith('..') ? path : inside;
  };
  const folder = (path: string, mode?: number) => {
    const created = mkdirSync(path, {
      recursive: true,
      ...(mode === undefined ? {} : { mode }),
    });
    if (created !== undefined && mode !== undefined) chmodSync(path, mode);
    return created !== undefined;
  };
  const file = (path: string, text: string) => {
    const created = writeIfMissing(path, text);
    entries.push({ path: shown(path), action: created ? 'created' : 'kept' });
  };

  folder(dir);
  const gitignore = join(dir, '.gitignore');
  const hadGitignore = existsSync(gitignore);
  const added = ensureGitignoreLine(gitignore, '.env');
  entries.push({
    path: '.gitignore',
    action: !hadGitignore ? 'created' : added ? 'updated' : 'kept',
  });

  const state = join(dir, STATE_DIR_NAME);
  folder(state, 0o700);
  file(join(state, '.gitignore'), STATE_GITIGNORE);
  const configFile = join(state, HOST_CONFIG_FILE);
  file(configFile, defaultHostConfig(data));

  const settings = resolveSettingsFolder(
    readHostConfig(configFile) ?? { data: null, settings: null },
    dir,
    home,
  );
  file(
    join(settings, 'Pero.md'),
    peroNote(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  folder(join(settings, 'Agents'));
  file(join(settings, 'Agents', 'Main.md'), MAIN_NOTE);
  const workflows = join(settings, 'Workflows');
  entries.push({
    path: `${shown(workflows)}/`,
    action: folder(workflows) ? 'created' : 'kept',
  });
  return { workspace: dir, entries };
}

/** Writes `text` to `path`, creating its folder; false when it existed. */
function writeIfMissing(path: string, text: string): boolean {
  mkdirSync(join(path, '..'), { recursive: true });
  let fd;
  try {
    fd = openSync(path, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}
