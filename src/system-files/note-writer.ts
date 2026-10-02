import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, posix } from 'node:path';
import { Document, isMap, parseDocument } from 'yaml';
import { slugify, SLUG_MAX_LENGTH } from '../config/slug.js';
import { NOTE_FOLDERS, noteIdentity } from './note-files.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** A property value a note can hold. */
export type NoteValue =
  string | number | boolean | readonly (string | number)[];

/**
 * The text of a note with `properties`, in the order given, and `body`.
 * Values are written as YAML 1.2, the way `parseNote` reads them back, so
 * text that would read as something else, such as `2026` or `5.5`, is
 * quoted. A note without properties is its body alone, unless the body
 * itself starts with a `---` line, which would read as properties.
 */
export function formatNote(
  properties: ReadonlyArray<readonly [string, NoteValue]>,
  body: string | null,
): string {
  const text = body?.trim() ?? '';
  const lines = text === '' ? [] : [text];
  if (properties.length === 0 && text.split('\n')[0]!.trimEnd() !== '---') {
    return lines.length === 0 ? '' : `${text}\n`;
  }
  const frontmatter =
    properties.length === 0
      ? ''
      : new Document(Object.fromEntries(properties), {
          version: '1.2',
        }).toString({ lineWidth: 0 });
  return ['---', `${frontmatter}---`, ...lines, ''].join('\n');
}

/** The template a new Channel's note starts from, in `Channels/`. */
export const CHANNEL_TEMPLATE = posix.join(
  NOTE_FOLDERS.channel,
  '_Template.md',
);

/** How long a new note's file name may be, before ` 2` and `.md`. */
const TITLE_MAX_LENGTH = 80;

/**
 * The file name, without `.md`, of the note for a Channel titled
 * `title`: characters that file systems or Obsidian links don't allow
 * become spaces, and a leading `_` or `.`, which would hide the note, is
 * dropped. Short enough that its name, and those of `<title> 2` and so
 * on, stay apart. `Topic <id>` when no letter or digit is left.
 */
export function topicNoteTitle(title: string, topicId: string): string {
  let cleaned = title
    .replace(/[/\\:*?"<>|#^[\]\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._]+/, '')
    .replace(/[\s.]+$/, '');
  const characters = Array.from(
    new Intl.Segmenter().segment(cleaned),
    ({ segment }) => segment,
  ).slice(0, TITLE_MAX_LENGTH);
  cleaned = characters.join('').trimEnd();
  while ((slugify(cleaned)?.length ?? 0) > SLUG_MAX_LENGTH - 4) {
    characters.pop();
    cleaned = characters.join('').trimEnd();
  }
  return slugify(cleaned) === null ? `Topic ${topicId}` : cleaned;
}

/**
 * A path for a new Channel note titled `title`, among `files`, the notes
 * in the system folder: `Channels/<title>.md`, or `<title> 2.md` and so
 * on, past files that exist and titles whose name a Channel note already
 * has.
 */
export function freeChannelNote(
  title: string,
  files: readonly string[],
): string {
  const taken = new Set<string>();
  const paths = new Set(files.map((file) => file.toLowerCase()));
  for (const file of files) {
    const found = noteIdentity(file);
    if (found.ok && found.identity.kind === 'channel') {
      taken.add(found.identity.name);
    }
  }
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? title : `${title} ${n}`;
    const file = posix.join(NOTE_FOLDERS.channel, `${candidate}.md`);
    if (paths.has(file.toLowerCase())) continue;
    if (taken.has(slugify(candidate)!)) continue;
    return file;
  }
}

/** A note's text split around its frontmatter, kept exactly as written. */
interface SplitNote {
  /** Everything up to and including the opening `---` line. */
  opening: string;
  /** The YAML between the delimiters. */
  frontmatter: string;
  /** The closing `---` line and everything after it. */
  rest: string;
}

/** `text` split around its frontmatter; null when it has none. */
function splitNote(text: string): SplitNote | null {
  const open = /^﻿?---[ \t]*\r?\n/.exec(text);
  if (open === null) return null;
  const close = /^---[ \t]*(?:\r?\n|$)/gm;
  close.lastIndex = open[0].length;
  const end = close.exec(text);
  if (end === null) return null;
  return {
    opening: open[0],
    frontmatter: text.slice(open[0].length, end.index),
    rest: text.slice(end.index),
  };
}

const YAML_OPTIONS = { version: '1.2' } as const;
const PRINT_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

/**
 * The note for the Channel `channelId`, from `template`: the text of
 * `_Template.md`, or Pero's own, with its properties, comments, and body,
 * and `channel-id` set. A commented-out `# channel-id:` line becomes the
 * property. With a template whose properties don't parse, `channel-id`
 * alone; `problem` then says what was wrong with it.
 */
export function noteFromTemplate(
  template: string,
  channelId: string,
): { text: string; problem: string | null } {
  const bare = formatNote([['channel-id', channelId]], null);
  const split = splitNote(template);
  const document: Document = parseDocument(
    split?.frontmatter ?? '',
    YAML_OPTIONS,
  );
  if (document.errors.length > 0) {
    return {
      text: bare,
      problem: `its properties don't parse: ${document.errors[0]!.message.split('\n')[0]}`,
    };
  }
  if (document.contents !== null && !isMap(document.contents)) {
    return {
      text: bare,
      problem: 'its properties must be "name: value" lines',
    };
  }
  const text = replaceNoteProperty(template, 'channel-id', channelId);
  if (text === null) return { text: bare, problem: "its properties don't parse" };
  return { text: text.endsWith('\n') ? text : `${text}\n`, problem: null };
}

/**
 * `text`, a note, with property `key` set to `value`, a plain YAML word.
 * A commented-out `# key: …` line in its frontmatter, as `pero init`
 * writes them, becomes the property, keeping its trailing comment in its
 * column; otherwise the property is added. A note without frontmatter
 * gains one. Null when the note sets `key` already or its properties
 * don't parse.
 */
export function setNoteProperty(
  text: string,
  key: string,
  value: string,
): string | null {
  const split = splitNote(text);
  if (split === null) return `${formatNote([[key, value]], null)}${text}`;
  const document: Document = parseDocument(split.frontmatter, YAML_OPTIONS);
  if (document.errors.length > 0) return null;
  if (document.contents !== null && !isMap(document.contents)) return null;
  if (isMap(document.contents) && document.contents.has(key)) return null;

  const property = `${key}: ${value}`;
  const commented = new RegExp(
    `^#[ \\t]*${key}:[^#\\n]*?(?:[ \\t]+(#.*))?$`,
    'm',
  ).exec(split.frontmatter);
  if (commented !== null) {
    const [line, comment] = commented;
    const column = comment === undefined ? 0 : line.lastIndexOf(comment);
    const replaced =
      comment === undefined
        ? property
        : `${property.padEnd(column - 1)} ${comment}`;
    const at = commented.index;
    const frontmatter =
      split.frontmatter.slice(0, at) +
      replaced +
      split.frontmatter.slice(at + line.length);
    return `${split.opening}${frontmatter}${split.rest}`;
  }
  document.set(key, value);
  return `${split.opening}${document.toString(PRINT_OPTIONS)}${split.rest}`;
}

/**
 * `text`, a note, with property `key` set to `value`, replacing the value
 * it has, or without it when `value` is null. A property on a line of its
 * own changes in place, keeping its trailing comment in its column; the
 * rest of the note stays exactly as written. A property the note doesn't
 * set yet is added as `setNoteProperty` adds it. A value that would read
 * as something else, such as `5.5`, is quoted. Null when the note's
 * properties don't parse.
 */
export function replaceNoteProperty(
  text: string,
  key: string,
  value: string | null,
): string | null {
  const split = splitNote(text);
  if (split === null) {
    return value === null ? text : setNoteProperty(text, key, value);
  }
  const document: Document = parseDocument(split.frontmatter, YAML_OPTIONS);
  if (document.errors.length > 0) return null;
  if (document.contents !== null && !isMap(document.contents)) return null;
  if (!(isMap(document.contents) && document.contents.has(key))) {
    return value === null ? text : setNoteProperty(text, key, value);
  }
  const inPlace = replaceLine(split.frontmatter, key, value);
  if (inPlace !== null) return `${split.opening}${inPlace}${split.rest}`;
  if (value === null) document.delete(key);
  else document.set(key, value);
  return `${split.opening}${document.toString(PRINT_OPTIONS)}${split.rest}`;
}

/**
 * `frontmatter` with `key`'s line set to `value`, or gone when `value` is
 * null; null when its value isn't on that one line, so the change must go
 * through the YAML document.
 */
function replaceLine(
  frontmatter: string,
  key: string,
  value: string | null,
): string | null {
  const line = new RegExp(
    `^${key}:[ \\t]*(?:"[^"\\n]*"|'[^'\\n]*'|[^#\\n]*?)(?:[ \\t]+(#.*))?[ \\t]*(?:\\n|$)`,
    'm',
  ).exec(frontmatter);
  if (line === null) return null;
  const [whole, comment] = line;
  let replaced = '';
  if (value !== null) {
    const property = `${key}: ${plainWord(value) ? value : JSON.stringify(value)}`;
    const column = comment === undefined ? 0 : whole.indexOf(comment);
    replaced =
      (comment === undefined
        ? property
        : `${property.padEnd(column - 1)} ${comment}`) +
      (whole.endsWith('\n') ? '\n' : '');
  }
  const result =
    frontmatter.slice(0, line.index) +
    replaced +
    frontmatter.slice(line.index + whole.length);
  // Whatever the regular expression missed, the document reads it back.
  const read = parseDocument(result, YAML_OPTIONS);
  if (read.errors.length > 0) return null;
  const got: unknown = read.get(key);
  return (value === null ? !read.has(key) : got === value) ? result : null;
}

/** Whether `value` reads back as itself when written bare after `key: `. */
function plainWord(value: string): boolean {
  if (!/^[A-Za-z][\w.\-/[\]@:]*$/.test(value)) return false;
  return parseDocument(`v: ${value}`, YAML_OPTIONS).get('v') === value;
}

/**
 * Writes `text` to `path` unless it exists, in one step: the text goes to a
 * temporary file beside it, which is synced and linked to `path`, so
 * readers never see half a note and an existing one is never replaced.
 * False when `path` exists. Where hard links aren't supported, the file is
 * created in place instead.
 */
export function createFileExclusive(path: string, text: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeSynced(temporary, text);
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') {
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  try {
    writeSynced(path, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

function writeSynced(path: string, text: string): void {
  const fd = openSync(path, 'wx', 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
