import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type { DynamicModule } from '@nestjs/common';
import { agentContext } from '../../agents/agent-request.js';
import { STATE_DIR_NAME } from '../../config/bootstrap-config.js';
import { HOST_CONFIG_FILE } from '../../config/host-config.js';
import { guideFile } from '../../guide/agent-guide.js';
import { HostConfigModule } from '../../host-config/host-config.module.js';
import { NOTE_FOLDERS, PERO_NOTE } from '../../system-files/note-files.js';
import { formatNote, type NoteValue } from '../../system-files/note-writer.js';
import { SystemNotes } from '../system-notes.service.js';

/** A note's properties; a null value leaves the property out. */
export type TestNoteProperties = Readonly<Record<string, NoteValue | null>>;

interface TestNote {
  properties: Record<string, NoteValue>;
  body: string | null;
}

/**
 * A workspace in a temporary folder for tests, with its system folder
 * in `data/System`: `Pero.md`, Agent, and Workflow notes are written
 * here, and a booted module reads them again after each write.
 */
export class TestWorkspace {
  /** The workspace. */
  readonly root: string;
  /** `data/`, where Agents without a folder of their own work. */
  readonly dataFolder: string;
  readonly systemFolder: string;
  /** `.pero/`. */
  readonly stateFolder: string;
  readonly database: string;
  /** `.env`, where the bot token is stored. */
  readonly envFile: string;
  /** The workspace's `.gitignore`. */
  readonly gitignore: string;
  private readonly notes = new Map<string, TestNote>();
  /** Each write gets a later modification time, whatever the clock. */
  private clock = Date.parse('2026-01-01T00:00:00Z');
  private module: {
    get: (token: typeof SystemNotes) => SystemNotes;
  } | null = null;

  private constructor(root: string) {
    this.root = root;
    this.dataFolder = join(root, 'data');
    this.systemFolder = join(this.dataFolder, 'System');
    this.stateFolder = join(root, STATE_DIR_NAME);
    this.database = join(this.stateFolder, 'pero.sqlite');
    this.envFile = join(root, '.env');
    this.gitignore = join(root, '.gitignore');
    mkdirSync(this.systemFolder, { recursive: true });
    mkdirSync(this.stateFolder, { recursive: true });
  }

  /**
   * What the instructions of the Agent with note `Agents/<title>.md` start
   * with in this workspace, its data folder `dataFolder`.
   */
  agentContext(title: string, dataFolder = this.dataFolder): string {
    return agentContext(
      { title, file: `${NOTE_FOLDERS.agent}/${title}.md` },
      {
        dataFolder,
        systemFolder: this.systemFolder,
        guideFile: guideFile(this.root),
      },
    );
  }

  /** A new, empty workspace; `remove` deletes it. */
  static create(prefix = 'pero-workspace-'): TestWorkspace {
    return new TestWorkspace(mkdtempSync(join(tmpdir(), prefix)));
  }

  /** The host config of the workspace, which makes Pero read its notes. */
  hostConfig(): DynamicModule {
    return HostConfigModule.forRoot({
      file: join(this.stateFolder, HOST_CONFIG_FILE),
      workspace: this.root,
    });
  }

  /**
   * Makes each later write rescan the notes of `moduleRef`, so it applies
   * before the write resolves.
   */
  use(moduleRef: { get: (token: typeof SystemNotes) => SystemNotes }): void {
    this.module = moduleRef;
  }

  /** Writes `file`, in the system folder, as `text`. */
  async write(file: string, text: string): Promise<void> {
    const path = join(this.systemFolder, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    this.clock += 1_000;
    utimesSync(path, new Date(this.clock), new Date(this.clock));
    await this.module?.get(SystemNotes).rescan();
  }

  /** The text of `file` in the system folder. */
  read(file: string): string {
    return readFileSync(join(this.systemFolder, file), 'utf8');
  }

  /** Deletes `file` from the system folder. */
  async remove(file: string): Promise<void> {
    rmSync(join(this.systemFolder, file), { force: true });
    this.notes.delete(file);
    await this.module?.get(SystemNotes).rescan();
  }

  /** Writes `Pero.md` with `properties` and `body`, the shared instructions. */
  pero(
    properties: TestNoteProperties = {},
    body?: string | null,
  ): Promise<void> {
    return this.note(PERO_NOTE, properties, body, true);
  }

  /** Changes `Pero.md`'s `properties`, keeping the others and its body. */
  editPero(
    properties: TestNoteProperties,
    body?: string | null,
  ): Promise<void> {
    return this.note(PERO_NOTE, properties, body, false);
  }

  /**
   * Writes the Agent note `Agents/<title>.md`, which defines the Agent
   * named after `title`, with `properties` and `body`, its instructions.
   */
  agent(
    title: string,
    properties: TestNoteProperties = {},
    body?: string | null,
  ): Promise<void> {
    return this.note(agentFile(title), properties, body, true);
  }

  /** Changes the Agent note of `title`, keeping its other properties. */
  editAgent(
    title: string,
    properties: TestNoteProperties,
    body?: string | null,
  ): Promise<void> {
    return this.note(agentFile(title), properties, body, false);
  }

  /**
   * Writes the Workflow note `Workflows/<title>.md`, which defines the
   * Workflow named after `title`, with `properties` and `body`, the input
   * each run sends.
   */
  workflow(
    title: string,
    properties: TestNoteProperties = {},
    body = `Run ${title}.`,
  ): Promise<void> {
    return this.note(workflowFile(title), properties, body, true);
  }

  /** Changes the Workflow note of `title`, keeping its other properties. */
  editWorkflow(
    title: string,
    properties: TestNoteProperties,
    body?: string,
  ): Promise<void> {
    return this.note(workflowFile(title), properties, body, false);
  }

  /** Deletes the Workflow note of `title`. */
  removeWorkflow(title: string): Promise<void> {
    return this.remove(workflowFile(title));
  }

  /**
   * Scans the notes again, as the next tick would: for Channels a Workflow
   * names that Pero has seen since.
   */
  async rescan(): Promise<void> {
    await this.module?.get(SystemNotes).rescan();
  }

  /** Deletes the workspace. */
  delete(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  private note(
    file: string,
    properties: TestNoteProperties,
    body: string | null | undefined,
    replace: boolean,
  ): Promise<void> {
    const note: TestNote = (!replace && this.notes.get(file)) || {
      properties: {},
      body: null,
    };
    for (const [key, value] of Object.entries(properties)) {
      if (value === null) delete note.properties[key];
      else note.properties[key] = value;
    }
    if (body !== undefined) note.body = body;
    this.notes.set(file, note);
    return this.write(
      file,
      formatNote(Object.entries(note.properties), note.body),
    );
  }
}

function agentFile(title: string): string {
  return posix.join(NOTE_FOLDERS.agent, `${title}.md`);
}

function workflowFile(title: string): string {
  return posix.join(NOTE_FOLDERS.workflow, `${title}.md`);
}
