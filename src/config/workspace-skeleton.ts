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
import { STATE_GITIGNORE } from './data-dir.js';
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

const PERO_NOTE = `---
# Installation defaults: each applies to every Agent and Workflow that
# doesn't set its own. Remove the # in front of a line to change it.
# provider: claude            # claude or codex
# claude-model: opus
# claude-effort: high
# codex-model: gpt-5.5
# permissions: ask            # ask or bypass
# timezone: Europe/Berlin     # the host's when not set
# main-agent: Main            # the Agent note for General topics and direct chats
# new-topics: create-agent    # or main-agent
# history-carryover: 50
# history-retention-days: 90  # keep everything when not set
# max-concurrent-runs: 2
---
You are a calm, concise personal assistant. Reply in the language you're written to in.
`;

const MAIN_NOTE = `---
# The main Agent: it answers the General topic of every allowed group,
# groups without topics, and direct chats. Remove the # to change a line.
# topics: [Health]            # topics it also answers in, by title
# provider: claude
# model: sonnet
# effort: high
# permissions: ask
# working-directory: projects/site   # relative to the workspace
---
You help with everyday questions and keep my notes tidy.
`;

const TEMPLATE_NOTE = `---
# The starting point for the Agent of a new topic: Pero copies these
# properties and this text, and sets topics to the topic's title.
# Files whose names start with _ are never Agents themselves.
# provider: claude
# model: sonnet
# effort: high
# permissions: ask
---
You are my assistant for this topic.
`;

/**
 * The notes `pero init` writes, by their path in the settings folder, so
 * `pero migrate` can tell them from the owner's.
 */
export const SKELETON_NOTES: Readonly<Record<string, string>> = {
  'Pero.md': PERO_NOTE,
  'Agents/Main.md': MAIN_NOTE,
  'Agents/_Template.md': TEMPLATE_NOTE,
};

/**
 * Makes `dir` a workspace, writing what is missing of the skeleton and
 * never overwriting a file: `.gitignore` listing `.env`, `.pero/` with its
 * `.gitignore` and a commented `config.yaml`, and in the settings folder
 * `Pero.md`, `Agents/Main.md`, `Agents/_Template.md`, and `Workflows/`.
 * In a cloned workspace it only fills in what is missing, and an existing
 * `config.yaml` decides where the settings folder is. Without `mainNote`,
 * `Agents/Main.md` is left out, for a workspace whose main Agent has
 * another note.
 */
export function initWorkspace(
  dir: string,
  home?: string,
  options: { mainNote?: boolean } = {},
): { workspace: string; entries: SkeletonEntry[] } {
  if (isHomeFolder(dir, home)) {
    throw new WorkspaceInitError(
      `${dir} is your home folder, which can't be a workspace: its .pero is the legacy data directory. Use a folder of its own, such as ~/workspace.`,
    );
  }
  if (existsSync(join(dir, 'pero.sqlite'))) {
    throw new WorkspaceInitError(
      `${dir} is a Pero data directory; make the workspace in another folder`,
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
  file(configFile, defaultHostConfig());

  const settings = resolveSettingsFolder(
    readHostConfig(configFile) ?? { data: null, settings: null },
    dir,
    home,
  );
  file(join(settings, 'Pero.md'), PERO_NOTE);
  folder(join(settings, 'Agents'));
  if (options.mainNote ?? true) {
    file(join(settings, 'Agents', 'Main.md'), MAIN_NOTE);
  }
  file(join(settings, 'Agents', '_Template.md'), TEMPLATE_NOTE);
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
