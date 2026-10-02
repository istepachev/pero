import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidInputError } from '../common/errors.js';
import { writeFileAtomic } from '../config/atomic-file.js';
import { SKELETON_NOTES } from '../config/workspace-skeleton.js';
import { noteIdentity } from '../system-files/note-files.js';
import {
  AGENT_TEMPLATE,
  agentNoteFor,
  createFileExclusive,
  freeAgentNote,
  noteFromTemplate,
  renameTopicIn,
  replaceNoteProperty,
  topicNoteTitle,
} from '../system-files/note-writer.js';
import { scanSystemFolder } from '../system-files/scan.js';
import { readNote } from '../system-files/snapshot.js';
import { SystemNotes } from './system-notes.service.js';

/** The note Pero writes for a main Agent that has none. */
const MAIN_NOTE = SKELETON_NOTES['Agents/Main.md']!;

/**
 * Writes the Agent notes Pero keeps up by itself: one for a topic no Agent
 * claims, the main Agent's when it has none, a renamed topic's title in
 * the note claiming it, and a property the owner sets with a command. Each write is atomic and logged, never replaces
 * a note it didn't mean to, and is in the snapshot when it resolves.
 */
@Injectable()
export class AgentNotes {
  private readonly logger = new Logger('System');
  /** The note written for each topic title, lowercased, while Pero runs. */
  private readonly written = new Map<string, string>();

  constructor(private readonly notes: SystemNotes) {}

  /**
   * Writes the Agent note for the topic titled `title` from `_Template.md`,
   * with `topic` set to the title. Returns its path in the system
   * folder, or null when Pero already wrote one for that title and it is
   * still there, since a second would only conflict with it.
   */
  async createForTopic(title: string, topicId: string): Promise<string | null> {
    const folder = this.systemFolder();
    const before = this.written.get(title.toLowerCase());
    if (before !== undefined && exists(join(folder, before))) {
      this.logger.warn(
        `Wrote no second note for topic "${title}": ${before} is for it already`,
      );
      return null;
    }
    const fileTitle = topicNoteTitle(title, topicId);
    const template = readTemplate(join(folder, AGENT_TEMPLATE));
    let { text, problem } = noteFromTemplate(template, title);
    if (problem === null) {
      const errors = readNote(`Agents/${fileTitle}.md`, text).errors;
      if (errors.length > 0) {
        problem = errors
          .map(
            (e) => (e.property === null ? '' : `${e.property}: `) + e.message,
          )
          .join('; ');
        text = noteFromTemplate(null, title).text;
      }
    }
    if (problem !== null) {
      this.logger.warn(
        `Left ${AGENT_TEMPLATE} out of the note for topic "${title}": ${problem}`,
      );
    }
    const files = (await scanSystemFolder(folder)).map((entry) => entry.file);
    // A file that appears meanwhile, as from a sync, is passed over.
    for (;;) {
      const file = freeAgentNote(fileTitle, files);
      if (createFileExclusive(join(folder, file), text)) {
        this.written.set(title.toLowerCase(), file);
        this.logger.log(`Wrote ${file} for topic "${title}"`);
        await this.notes.refresh();
        return file;
      }
      files.push(file);
    }
  }

  /**
   * Writes the note of the main Agent, named `name`, from the skeleton's
   * `Main.md`. Returns its path, or null when an Agent note of that name
   * exists anywhere, even one with errors, which a new note would only
   * clash with.
   */
  async createMain(name: string): Promise<string | null> {
    const folder = this.systemFolder();
    const files = (await scanSystemFolder(folder)).map((entry) => entry.file);
    const existing = files.find((file) => {
      const found = noteIdentity(file);
      return (
        found.ok &&
        found.identity.kind === 'agent' &&
        found.identity.name === name
      );
    });
    if (existing !== undefined) {
      this.logger.debug(`Kept ${existing}, the main Agent's note, as it is`);
      return null;
    }
    const file = agentNoteFor(name);
    if (!createFileExclusive(join(folder, file), MAIN_NOTE)) return null;
    this.logger.log(`Wrote ${file} for the main Agent, ${name}`);
    await this.notes.refresh();
    return file;
  }

  /**
   * Sets the `topic` of `file`, a note in the system folder, from `from`
   * to `to`, keeping the note's comments and body. False, after a note in
   * the log, when its topic is no longer `from` or it doesn't parse.
   */
  async renameTopic(file: string, from: string, to: string): Promise<boolean> {
    const path = join(this.systemFolder(), file);
    let text: string;
    let mode: number;
    try {
      text = readFileSync(path, 'utf8');
      mode = statSync(path).mode & 0o777;
    } catch (error) {
      this.logger.warn(
        `Could not rename topic "${from}" in ${file}: ${describe(error)}`,
      );
      return false;
    }
    const renamed = renameTopicIn(text, from, to);
    if (renamed === null) {
      this.logger.warn(
        `Left ${file} as it is: its topic isn't "${from}", or its properties don't parse`,
      );
      return false;
    }
    writeFileAtomic(path, renamed, mode);
    this.logger.log(`Renamed topic "${from}" to "${to}" in ${file}`);
    await this.notes.refresh();
    return true;
  }

  /**
   * Sets `key` in the note of the Agent named `name` to `value`, or removes
   * it when null, keeping the note's comments and body. Resolves to the
   * note's path in the system folder, once the snapshot has the change,
   * and whether anything changed. `InvalidInputError` when the note can't
   * take it: it is gone, its properties don't parse, or the value is wrong.
   */
  async setProperty(
    name: string,
    key: string,
    value: string | null,
  ): Promise<{ file: string; changed: boolean }> {
    const file = this.notes.snapshot()?.agents.get(name)?.file;
    if (file === undefined) {
      throw new InvalidInputError(`Agent ${name} has no note to change`);
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
