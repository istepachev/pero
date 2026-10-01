import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

/**
 * How an `ask` Agent's tool is approved: `allow` runs it without asking,
 * `settings` edits the settings folder, which only the owner may approve,
 * and `ask` asks the owner as any other tool does.
 */
export type EditDecision = 'allow' | 'settings' | 'ask';

/** Claude Code's file-editing tools, by the input naming the file. */
const EDIT_TOOLS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

/**
 * Folders and files that configure Claude Code, Git, editors, or the
 * shell. Claude Code asks before editing them even when it accepts edits,
 * since they can run commands or grant permissions, so they keep asking.
 * So do Pero's own state folder and `.env` with the bot token, which sit
 * in the workspace Agents work in by default.
 */
const CONFIG_FOLDERS = new Set([
  '.claude',
  '.git',
  '.vscode',
  '.idea',
  '.pero',
]);
const CONFIG_FILES = new Set([
  '.env',
  '.mcp.json',
  '.claude.json',
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
]);

/**
 * Decides about `tool`, called with `input`, for an Agent working in
 * `workingDirectory`: an edit in its folder is allowed, except under
 * `settingsFolder` and of the configuration files above, each resolved
 * through `../` and symlinks. Anything else asks, and so does a path that
 * can't be resolved.
 */
export async function editDecision(
  tool: string,
  input: Record<string, unknown>,
  folders: { workingDirectory: string; settingsFolder?: string },
): Promise<EditDecision> {
  const key = EDIT_TOOLS[tool];
  const path = key === undefined ? undefined : input[key];
  if (typeof path !== 'string' || path === '') return 'ask';
  try {
    const target = await realPath(
      resolve(folders.workingDirectory, expandHome(path)),
    );
    if (
      folders.settingsFolder !== undefined &&
      inside(await realPath(folders.settingsFolder), target)
    ) {
      return 'settings';
    }
    const folder = await realPath(folders.workingDirectory);
    return inside(folder, target) && !isConfig(relative(folder, target))
      ? 'allow'
      : 'ask';
  } catch {
    return 'ask';
  }
}

/** `path` with a leading `~`, which Claude Code expands, expanded. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Absolute `path` with every symlink resolved, including a file or folders
 * at its end that don't exist yet: the nearest existing ancestor is
 * resolved and the rest appended.
 */
async function realPath(path: string): Promise<string> {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(await realpath(existing), ...missing.reverse());
    } catch (error) {
      const parent = dirname(existing);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** Whether `path` is `folder` or inside it; both absolute and resolved. */
function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

/** Whether `path`, relative to the working folder, configures a tool. */
function isConfig(path: string): boolean {
  const parts = path.split(sep);
  return (
    parts.some((part) => CONFIG_FOLDERS.has(part)) ||
    CONFIG_FILES.has(parts.at(-1)!)
  );
}
