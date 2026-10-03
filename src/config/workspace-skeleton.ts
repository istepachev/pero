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
  resolveSystemFolder,
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
 * `Pero.md` as `pero init` writes it: every setting as a property, so
 * Obsidian shows each one to change, with Pero's defaults or else empty.
 * `timezone` is the host's, so the owner sees the zone schedules use;
 * `provider` and `permissions` are left for the first `pero run` to fill
 * in.
 */
export function peroNote(timeZone: string): string {
  const timezone = `timezone: ${timeZone}`;
  return `---
# Installation defaults: each applies to every Channel and Workflow that
# doesn't set its own. An empty property takes the default: claude for
# provider, ask for permissions, and the provider's own model and effort.
# Instructions go in Persona.md, Instructions.md, and the Channels' notes.
provider:                     # claude or codex
claude-model:                 # such as opus or sonnet
claude-effort:                # low, medium, high, xhigh, or max
codex-model:                  # such as gpt-5.5
codex-effort:                 # minimal, low, medium, high, xhigh, max, ultra, or persistent
permissions:                  # ask or bypass
${timezone.padEnd(29)} # this server's; set yours, such as Europe/Berlin
history-carryover: 50
history-retention-days:       # keep everything when empty
max-concurrent-runs: 2
---
`;
}

const PERSONA_NOTE = `You are a calm, concise personal assistant. Reply in the language you're written to in.
`;

const INSTRUCTIONS_NOTE = `You help with everyday questions and keep my notes tidy.
`;

/** The settings every Channel note lists, as Pero writes them. */
const CHANNEL_SETTINGS = `# A property left empty takes Pero.md's value.
provider:                            # claude or codex
model:                               # such as opus or sonnet
effort:                              # such as low, medium, or high
permissions:                         # ask or bypass
# working-directory: projects/site   # relative to the workspace`;

/**
 * The note Pero writes for a new Channel when `Channels/_Template.md`
 * doesn't exist; it sets `channel-id` in it.
 */
export const CHANNEL_TEMPLATE_NOTE = `---
# This Channel's settings and instructions: its turns start with
# Persona.md and Instructions.md, then the text below.
# channel-id binds the note to its Channel; keep it as Pero wrote it.
channel-id:
${CHANNEL_SETTINGS}
---
`;

const DEFAULT_NOTE = `---
# The Default Channel: General topics, groups without topics, and direct
# chats. Its turns start with Persona.md and Instructions.md, then the
# text below.
${CHANNEL_SETTINGS}
---
`;

/**
 * The notes Pero writes when they are missing, as they are, by their path
 * in the system folder; `Pero.md`, which holds the host's time zone, is
 * `peroNote`'s.
 */
export const SKELETON_NOTES: Readonly<Record<string, string>> = {
  'Persona.md': PERSONA_NOTE,
  'Instructions.md': INSTRUCTIONS_NOTE,
  'Channels/Default.md': DEFAULT_NOTE,
};

/**
 * Makes `dir` a workspace, writing what is missing of the skeleton and
 * never overwriting a file: `.gitignore` listing `.env`, `.pero/` with its
 * `.gitignore` and a commented `config.yaml` naming `data` as the data
 * folder (`data/` by default), and in the system folder `Pero.md`,
 * `Persona.md`, `Instructions.md`, `Channels/Default.md`, and `Workflows/`.
 * In a cloned workspace it only fills in what is missing, and an existing
 * `config.yaml` decides where the system folder is.
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

  const system = resolveSystemFolder(
    readHostConfig(configFile) ?? { data: null, system: null },
    dir,
    home,
  );
  file(
    join(system, 'Pero.md'),
    peroNote(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  for (const [path, text] of Object.entries(SKELETON_NOTES)) {
    file(join(system, path), text);
  }
  const workflows = join(system, 'Workflows');
  entries.push({
    path: `${shown(workflows)}/`,
    action: folder(workflows) ? 'created' : 'kept',
  });
  return { workspace: dir, entries };
}

/** Writes `text` to `path`, creating its folder; false when it existed. */
export function writeIfMissing(path: string, text: string): boolean {
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
