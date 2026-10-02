import { posix } from 'node:path';
import { slugify } from '../config/slug.js';
import type { NoteError } from './note-error.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** The installation defaults, at the system folder's root. */
export const PERO_NOTE = 'Pero.md';

/** Folders of the system folder that hold notes, by the kind they hold. */
export const NOTE_FOLDERS = { agent: 'Agents', workflow: 'Workflows' } as const;

export type NoteKind = 'pero' | keyof typeof NOTE_FOLDERS;

/** What a note is, from where it is and what it is called. */
export interface NoteIdentity {
  kind: NoteKind;
  /** The file name without `.md`, such as `Weekly Health`. */
  title: string;
  /** The title as a slug, such as `weekly-health`: what Pero calls it. */
  name: string;
}

export type NoteIdentityResult =
  { ok: true; identity: NoteIdentity } | { ok: false; error: NoteError };

const NOTE_EXTENSION = '.md';

/**
 * Whether Pero skips `file`, a `/`-separated path inside the system
 * folder: anything but a `.md` file, and anything whose name or folder
 * starts with `_` or `.`, such as `Agents/_Template.md` or `.obsidian/`.
 */
export function isIgnoredPath(file: string): boolean {
  return (
    !file.endsWith(NOTE_EXTENSION) ||
    file
      .split('/')
      .some((segment) => segment.startsWith('_') || segment.startsWith('.'))
  );
}

/**
 * The identity of the note at `file`, a `/`-separated path inside the
 * system folder that `isIgnoredPath` keeps. Subfolders of `Agents/` and
 * `Workflows/` are for the owner's grouping and don't change the name.
 */
export function noteIdentity(file: string): NoteIdentityResult {
  const [top, ...rest] = file.split('/');
  const title = posix.basename(file, NOTE_EXTENSION);
  let kind: NoteKind;
  if (file === PERO_NOTE) {
    kind = 'pero';
  } else if (rest.length > 0 && top === NOTE_FOLDERS.agent) {
    kind = 'agent';
  } else if (rest.length > 0 && top === NOTE_FOLDERS.workflow) {
    kind = 'workflow';
  } else {
    return failure(
      file,
      `not an Agent or Workflow note; move it under ${NOTE_FOLDERS.agent}/ or ${NOTE_FOLDERS.workflow}/, or start its name with _`,
    );
  }
  const name = slugify(title);
  if (name === null) {
    return failure(
      file,
      'the file name needs a letter or digit to make a name from',
    );
  }
  return { ok: true, identity: { kind, title, name } };
}

function failure(file: string, message: string): NoteIdentityResult {
  return { ok: false, error: { file, property: null, message } };
}
