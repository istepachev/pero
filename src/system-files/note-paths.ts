import { relative } from 'node:path';
import { slugify } from '../config/slug.js';
import { NOTE_FOLDERS, noteIdentity } from './note-files.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** `path` as the owner reads it: inside the workspace, relative to it. */
export function shownPath(workspace: string, path: string): string {
  const inside = relative(workspace, path);
  return inside === '' || inside.startsWith('..') ? path : inside;
}

/**
 * The note that defines the Workflow named `name`, in any case or as its
 * title, among `files`, the paths in the system folder; null if none.
 */
export function findWorkflowNote(
  files: readonly string[],
  name: string,
): string | null {
  return findNote(files, 'workflow', name);
}

function findNote(
  files: readonly string[],
  kind: keyof typeof NOTE_FOLDERS,
  name: string,
): string | null {
  const wanted = slugify(name) ?? name.toLowerCase();
  for (const file of files) {
    const found = noteIdentity(file);
    if (
      found.ok &&
      found.identity.kind === kind &&
      found.identity.name === wanted
    ) {
      return file;
    }
  }
  return null;
}
