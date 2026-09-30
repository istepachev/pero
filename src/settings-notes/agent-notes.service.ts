import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../config/atomic-file.js';
import { SKELETON_NOTES } from '../config/workspace-skeleton.js';
import { noteIdentity } from '../settings-files/note-files.js';
import {
  AGENT_TEMPLATE,
  agentNoteFor,
  createFileExclusive,
  freeAgentNote,
  noteFromTemplate,
  renameTopicIn,
  topicNoteTitle,
} from '../settings-files/note-writer.js';
import { scanSettingsFolder } from '../settings-files/scan.js';
import { readNote } from '../settings-files/snapshot.js';
import { SettingsNotes } from './settings-notes.service.js';

/** The note Pero writes for a main Agent that has none. */
const MAIN_NOTE = SKELETON_NOTES['Agents/Main.md']!;

/**
 * Writes the Agent notes Pero keeps up by itself: one for a topic no Agent
 * claims, the main Agent's when it has none, and a renamed topic's title
 * in the note claiming it. Each write is atomic and logged, never replaces
 * a note it didn't mean to, and is in the snapshot when it resolves.
 */
@Injectable()
export class AgentNotes {
  private readonly logger = new Logger('Settings');
  /** The note written for each topic title, lowercased, while Pero runs. */
  private readonly written = new Map<string, string>();

  constructor(private readonly notes: SettingsNotes) {}

  /**
   * Writes the Agent note for the topic titled `title` from `_Template.md`,
   * with `topics` set to the title. Returns its path in the settings
   * folder, or null when Pero already wrote one for that title and it is
   * still there, since a second would only conflict with it.
   */
  async createForTopic(title: string, topicId: string): Promise<string | null> {
    const folder = this.settingsFolder();
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
    const files = (await scanSettingsFolder(folder)).map((entry) => entry.file);
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
    const folder = this.settingsFolder();
    const files = (await scanSettingsFolder(folder)).map((entry) => entry.file);
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
   * Renames topic `from` to `to` in the `topics` of `file`, a note in the
   * settings folder, or adds `to` after it with `keep`, keeping the note's
   * comments and body. False, after a note in the log, when the note no
   * longer lists `from` or doesn't parse.
   */
  async renameTopic(
    file: string,
    from: string,
    to: string,
    keep: boolean,
  ): Promise<boolean> {
    const path = join(this.settingsFolder(), file);
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
    const renamed = renameTopicIn(text, from, to, keep);
    if (renamed === null) {
      this.logger.warn(
        `Left ${file} as it is: its topics don't list "${from}", or its properties don't parse`,
      );
      return false;
    }
    writeFileAtomic(path, renamed, mode);
    this.logger.log(
      keep
        ? `Added topic "${to}" to ${file}, keeping "${from}" for the other topics of that title`
        : `Renamed topic "${from}" to "${to}" in ${file}`,
    );
    await this.notes.refresh();
    return true;
  }

  private settingsFolder(): string {
    const folders = this.notes.folders();
    if (folders === null) {
      throw new Error('Pero writes Agent notes only in a workspace');
    }
    return folders.settingsFolder;
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
