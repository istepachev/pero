import { posix } from 'node:path';
import { slugify } from '../config/slug.js';
import type { NoteError } from './note-error.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** The installation defaults, at the system folder's root. */
export const PERO_NOTE = 'Pero.md';

/** Pero's personality, which every turn's instructions start with. */
export const PERSONA_NOTE = 'Persona.md';

/** Pero's general instructions, which follow the persona in every turn. */
export const INSTRUCTIONS_NOTE = 'Instructions.md';

/** Folders of the system folder that hold notes, by the kind they hold. */
export const NOTE_FOLDERS = {
  channel: 'Channels',
  workflow: 'Workflows',
} as const;

/** The notes at the system folder's root, by the kind each is. */
const ROOT_NOTES = {
  [PERO_NOTE]: 'pero',
  [PERSONA_NOTE]: 'persona',
  [INSTRUCTIONS_NOTE]: 'instructions',
} as const;

export type NoteKind =
  (typeof ROOT_NOTES)[keyof typeof ROOT_NOTES] | keyof typeof NOTE_FOLDERS;

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

const NOTE_FOLDER_NAMES: ReadonlySet<string> = new Set(
  Object.values(NOTE_FOLDERS),
);

/**
 * Whether `name`, a folder at the system folder's root, holds notes:
 * `Channels/` and `Workflows/`. Every other folder there is the owner's,
 * such as `Templates/`, and Pero never enters it.
 */
export function isNoteFolder(name: string): boolean {
  return NOTE_FOLDER_NAMES.has(name);
}

/** Whether `file`, a path inside the system folder, is one of its root notes. */
function isRootNote(file: string): file is keyof typeof ROOT_NOTES {
  return Object.hasOwn(ROOT_NOTES, file);
}

/**
 * Whether Pero skips `file`, a `/`-separated path inside the system
 * folder: anything but `Pero.md`, `Persona.md`, `Instructions.md`, and the
 * `.md` files under `Channels/` and `Workflows/`, and anything whose name
 * or folder starts with `_` or `.`, such as `Channels/_Template.md`. The
 * rest of the system folder is the owner's, such as `Templates/` or
 * `.obsidian/`.
 */
export function isIgnoredPath(file: string): boolean {
  const segments = file.split('/');
  if (!file.endsWith(NOTE_EXTENSION)) return true;
  if (segments.some((name) => name.startsWith('_') || name.startsWith('.'))) {
    return true;
  }
  if (isRootNote(file)) return false;
  return !(segments.length > 1 && isNoteFolder(segments[0]!));
}

/**
 * The identity of the note at `file`, a `/`-separated path inside the
 * system folder that `isIgnoredPath` keeps. Subfolders of `Channels/` and
 * `Workflows/` are for the owner's grouping and don't change the name.
 */
export function noteIdentity(file: string): NoteIdentityResult {
  const [top, ...rest] = file.split('/');
  const title = posix.basename(file, NOTE_EXTENSION);
  let kind: NoteKind;
  if (isRootNote(file)) {
    kind = ROOT_NOTES[file];
  } else if (rest.length > 0 && top === NOTE_FOLDERS.channel) {
    kind = 'channel';
  } else if (rest.length > 0 && top === NOTE_FOLDERS.workflow) {
    kind = 'workflow';
  } else {
    return failure(
      file,
      `not a note Pero reads; Pero reads only ${PERO_NOTE}, ${PERSONA_NOTE}, ${INSTRUCTIONS_NOTE}, and notes under ${NOTE_FOLDERS.channel}/ and ${NOTE_FOLDERS.workflow}/`,
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
