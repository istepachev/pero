import { type Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isIgnoredPath } from './note-files.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** A note found in the system folder, with what shows it changed. */
export interface NoteEntry {
  /** Its `/`-separated path inside the system folder. */
  file: string;
  size: number;
  mtimeMs: number;
}

/** A note and its text. */
export interface NoteFile {
  file: string;
  text: string;
}

/**
 * Every note in the system folder `dir`, sorted by path: `.md` files in
 * any subfolder, leaving out names that start with `_` or `.` and never
 * entering such folders, so `.obsidian/` and `.trash/` cost nothing.
 * Linked files are read; linked folders are not entered. A missing folder
 * has no notes.
 */
export async function scanSystemFolder(dir: string): Promise<NoteEntry[]> {
  const entries: NoteEntry[] = [];
  await walk(dir, '', entries);
  return entries.sort((a, b) => compare(a.file, b.file));
}

/** The text of each of `entries` in `dir`; one gone since the scan is left out. */
export async function readNotes(
  dir: string,
  entries: readonly NoteEntry[],
): Promise<NoteFile[]> {
  const notes = await Promise.all(
    entries.map(async ({ file }) => {
      try {
        return { file, text: await readFile(join(dir, file), 'utf8') };
      } catch (error) {
        if (isGone(error)) return null;
        throw error;
      }
    }),
  );
  return notes.filter((note) => note !== null);
}

async function walk(
  root: string,
  prefix: string,
  entries: NoteEntry[],
): Promise<void> {
  let children: Dirent[];
  try {
    children = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error) {
    // The folder itself may be missing, or a subfolder removed mid-scan.
    if (isGone(error)) return;
    throw error;
  }
  for (const child of children) {
    const file = prefix === '' ? child.name : `${prefix}/${child.name}`;
    if (child.name.startsWith('_') || child.name.startsWith('.')) continue;
    if (child.isDirectory()) {
      await walk(root, file, entries);
      continue;
    }
    if (isIgnoredPath(file) || !(child.isFile() || child.isSymbolicLink())) {
      continue;
    }
    try {
      const stats = await stat(join(root, file));
      if (stats.isFile()) {
        entries.push({ file, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    } catch (error) {
      // Removed since the listing, or a link to nothing.
      if (!isGone(error)) throw error;
    }
  }
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Code-point order, the same on every platform and locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
