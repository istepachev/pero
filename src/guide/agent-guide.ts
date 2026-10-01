import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR_NAME } from '../config/bootstrap-config.js';
import { writeFileAtomic } from '../config/atomic-file.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** The guide's file name in a workspace's `.pero/`. */
export const GUIDE_FILE_NAME = 'guide.md';

/**
 * The guide for Agents: how Pero's settings work and how to change them.
 * It ships beside this module, in `src/` and in `dist/` alike.
 */
export function agentGuide(): string {
  return readFileSync(new URL(`./${GUIDE_FILE_NAME}`, import.meta.url), 'utf8');
}

/** Where `workspace` keeps the guide: `.pero/guide.md`. */
export function guideFile(workspace: string): string {
  return join(workspace, STATE_DIR_NAME, GUIDE_FILE_NAME);
}

/**
 * Writes this version's guide to `path` unless it holds it already, so
 * that the guide Agents read always matches the running Pero. Returns
 * whether it wrote.
 */
export function writeAgentGuide(path: string): boolean {
  const text = agentGuide();
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current === text) return false;
  writeFileAtomic(path, text, 0o644);
  return true;
}
