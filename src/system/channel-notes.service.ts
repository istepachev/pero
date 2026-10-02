import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidInputError } from '../common/errors.js';
import { writeFileAtomic } from '../config/atomic-file.js';
import {
  CHANNEL_TEMPLATE_NOTE,
  SKELETON_NOTES,
} from '../config/workspace-skeleton.js';
import { noteIdentity } from '../system-files/note-files.js';
import {
  CHANNEL_TEMPLATE,
  createFileExclusive,
  freeChannelNote,
  noteFromTemplate,
  replaceNoteProperty,
  topicNoteTitle,
} from '../system-files/note-writer.js';
import { parseNote } from '../system-files/note.js';
import { scanSystemFolder } from '../system-files/scan.js';
import { channelIdOf } from '../system-files/schemas.js';
import {
  DEFAULT_NOTE,
  DEFAULT_NOTE_FILE,
  readNote,
} from '../system-files/snapshot.js';
import { SystemNotes } from './system-notes.service.js';

/**
 * Writes the Channel notes Pero keeps up by itself: one for a Channel that
 * has none, `Default.md` when it is missing, a note's `channel-id` when it
 * binds the note or the chat moves, and a property the owner sets with a
 * command. Each write is atomic and logged, never replaces a note it
 * didn't mean to, and is in the snapshot when it resolves.
 */
@Injectable()
export class ChannelNotes {
  private readonly logger = new Logger('System');
  /** The note written for each Channel ID while Pero runs. */
  private readonly written = new Map<string, string>();

  constructor(private readonly notes: SystemNotes) {}

  /**
   * Writes the note for the Channel `channelId`, titled `title`, from
   * `_Template.md` or else Pero's own template, with `channel-id` set.
   * Returns its path in the system folder, or null when Pero already
   * wrote one for that Channel and it is still there.
   */
  async createFor(
    channelId: string,
    title: string,
    topicId: string,
  ): Promise<string | null> {
    const folder = this.systemFolder();
    const before = this.written.get(channelId);
    if (before !== undefined && exists(join(folder, before))) {
      this.logger.warn(
        `Wrote no second note for Channel ${channelId}: ${before} is for it already`,
      );
      return null;
    }
    const fileTitle = topicNoteTitle(title, topicId);
    const template = readTemplate(join(folder, CHANNEL_TEMPLATE));
    let { text, problem } = noteFromTemplate(
      template ?? CHANNEL_TEMPLATE_NOTE,
      channelId,
    );
    if (problem === null && template !== null) {
      const errors = readNote(`Channels/${fileTitle}.md`, text).errors;
      if (errors.length > 0) {
        problem = errors
          .map(
            (e) => (e.property === null ? '' : `${e.property}: `) + e.message,
          )
          .join('; ');
      }
    }
    if (problem !== null) {
      this.logger.warn(
        `Left ${CHANNEL_TEMPLATE} out of the note for Channel "${title}": ${problem}`,
      );
      text = noteFromTemplate(CHANNEL_TEMPLATE_NOTE, channelId).text;
    }
    const files = (await scanSystemFolder(folder)).map((entry) => entry.file);
    // A file that appears meanwhile, as from a sync, is passed over.
    for (;;) {
      const file = freeChannelNote(fileTitle, files);
      if (createFileExclusive(join(folder, file), text)) {
        this.written.set(channelId, file);
        this.logger.log(`Wrote ${file} for Channel "${title}"`);
        await this.notes.refresh();
        return file;
      }
      files.push(file);
    }
  }

  /**
   * Writes `Default.md` from the skeleton. Returns its path, or null when
   * a Channel note named `default` exists anywhere, even one with errors,
   * which a new note would only clash with.
   */
  async createDefault(): Promise<string | null> {
    const folder = this.systemFolder();
    const files = (await scanSystemFolder(folder)).map((entry) => entry.file);
    const existing = files.find((file) => {
      const found = noteIdentity(file);
      return (
        found.ok &&
        found.identity.kind === 'channel' &&
        found.identity.name === DEFAULT_NOTE
      );
    });
    if (existing !== undefined) {
      this.logger.debug(`Kept ${existing}, the Default note, as it is`);
      return null;
    }
    const file = DEFAULT_NOTE_FILE;
    if (!createFileExclusive(join(folder, file), SKELETON_NOTES[file]!)) {
      return null;
    }
    this.logger.log(`Wrote ${file} for General topics and direct chats`);
    await this.notes.refresh();
    return file;
  }

  /**
   * Binds `file`, a Channel note without `channel-id`, to the Channel
   * `channelId`, keeping its comments and body. False, after a note in the
   * log, when it has a `channel-id` meanwhile or doesn't parse.
   */
  async bind(file: string, channelId: string): Promise<boolean> {
    const changed = this.rewrite(file, (text) => {
      const parsed = parseNote(file, text);
      if (!parsed.ok) return null;
      if (parsed.note.properties['channel-id'] != null) return null;
      return replaceNoteProperty(text, 'channel-id', channelId);
    });
    if (changed) this.logger.log(`Bound ${file} to Channel ${channelId}`);
    else this.logger.warn(`Left ${file} as it is: it couldn't be bound`);
    if (changed) await this.notes.refresh();
    return changed;
  }

  /**
   * Moves every note bound to a Channel of the chat `from`, such as
   * `telegram:-100…`, to the same Channel of the chat `to`, as when a group
   * gains topics and Telegram gives it a new ID.
   */
  async rebindChat(from: string, to: string): Promise<void> {
    const folder = this.systemFolder();
    let moved = false;
    for (const { file } of await scanSystemFolder(folder)) {
      const found = noteIdentity(file);
      if (!found.ok || found.identity.kind !== 'channel') continue;
      const changed = this.rewrite(file, (text) => {
        const parsed = parseNote(file, text);
        if (!parsed.ok) return null;
        const id = channelIdOf(parsed.note.properties['channel-id']);
        if (id === null || !(id === from || id.startsWith(`${from}:`))) {
          return null;
        }
        return replaceNoteProperty(
          text,
          'channel-id',
          `${to}${id.slice(from.length)}`,
        );
      });
      if (changed) {
        moved = true;
        this.logger.log(`Moved ${file} from chat ${from} to ${to}`);
      }
    }
    if (moved) await this.notes.refresh();
  }

  /**
   * Sets `key` in the Channel note named `name` to `value`, or removes it
   * when null, keeping the note's comments and body. Resolves to the
   * note's path in the system folder, once the snapshot has the change,
   * and whether anything changed. `InvalidInputError` when the note can't
   * take it: it is gone, its properties don't parse, or the value is wrong.
   */
  async setProperty(
    name: string,
    key: string,
    value: string | null,
  ): Promise<{ file: string; changed: boolean }> {
    const file = this.notes.snapshot()?.channelNotes.get(name)?.file;
    if (file === undefined || file === null) {
      throw new InvalidInputError(
        `This Channel has no note yet; send a message here first`,
      );
    }
    const path = join(this.systemFolder(), file);
    const text = readFileSync(path, 'utf8');
    const mode = statSync(path).mode & 0o777;
    const changed = replaceNoteProperty(text, key, value);
    if (changed === null) {
      throw new InvalidInputError(
        `${file}'s properties don't parse; pero check lists the errors`,
      );
    }
    const error = readNote(file, changed).errors.find(
      (found) => found.property === key,
    );
    if (error !== undefined) {
      throw new InvalidInputError(`${key}: ${error.message}`);
    }
    if (changed === text) return { file, changed: false };
    writeFileAtomic(path, changed, mode);
    this.logger.log(
      value === null
        ? `Removed ${key} from ${file}`
        : `Set ${key} to ${value} in ${file}`,
    );
    await this.notes.refresh();
    return { file, changed: true };
  }

  /** Rewrites `file` with what `change` makes of it; false for null or no change. */
  private rewrite(
    file: string,
    change: (text: string) => string | null,
  ): boolean {
    const path = join(this.systemFolder(), file);
    let text: string;
    let mode: number;
    try {
      text = readFileSync(path, 'utf8');
      mode = statSync(path).mode & 0o777;
    } catch (error) {
      this.logger.warn(`Could not read ${file}: ${describe(error)}`);
      return false;
    }
    const changed = change(text);
    if (changed === null || changed === text) return false;
    writeFileAtomic(path, changed, mode);
    return true;
  }

  private systemFolder(): string {
    return this.notes.folders().systemFolder;
  }
}

/** The template's text; null when there is none. */
function readTemplate(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
