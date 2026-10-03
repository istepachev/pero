import { join } from 'node:path';
import type { RuntimeRequest } from '../runtimes/agent-runtime.js';
import {
  INSTRUCTIONS_NOTE,
  NOTE_FOLDERS,
  PERO_NOTE,
  PERSONA_NOTE,
} from '../system-files/note-files.js';
import type { ChannelNote } from '../system-files/snapshot.js';

/** What a runtime request takes from the Channel note it runs with. */
export type AgentRequest = Required<
  Pick<
    RuntimeRequest,
    | 'instructions'
    | 'providerOptions'
    | 'workingDirectory'
    | 'skipGitRepoCheck'
    | 'toolPolicy'
  >
>;

/** What composing a turn's instructions takes from the defaults. */
export interface InstructionDefaults {
  /** Named in every turn's instructions as where notes go. */
  dataFolder: string;
  /** Where every turn's instructions find its notes and `Pero.md`. */
  systemFolder: string;
  /** The guide to Pero's settings that every turn's instructions name. */
  guideFile: string;
  /** `Persona.md`'s text; null for none. */
  persona: string | null;
  /** `Instructions.md`'s text; null for none. */
  instructions: string | null;
  /** Whether Pero can record voice messages, which the context then says. */
  voice?: boolean;
}

/** The runtime request of a turn with `note`, with its instructions composed. */
export function agentRequest(
  note: ChannelNote,
  defaults: InstructionDefaults,
): AgentRequest {
  return {
    instructions: composeInstructions(note, defaults),
    providerOptions: { model: note.model, effort: note.effort },
    workingDirectory: note.workingDirectory,
    skipGitRepoCheck: note.skipGitRepoCheck,
    toolPolicy: { permissions: note.permissions },
  };
}

/**
 * The instructions sent to the runtime: the context (where the data folder
 * is, and where the settings are), `Persona.md`, `Instructions.md`, then
 * the Channel note's own, separated by blank lines. Empty parts are left
 * out.
 */
export function composeInstructions(
  note: Pick<ChannelNote, 'title' | 'file' | 'instructions'>,
  defaults: InstructionDefaults,
): string {
  const parts = [
    agentContext(note, defaults),
    defaults.persona,
    defaults.instructions,
    note.instructions,
  ];
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
}

/**
 * What every turn's instructions start with: where the data folder is,
 * and where the settings are.
 */
export function agentContext(
  note: Pick<ChannelNote, 'title' | 'file'>,
  defaults: Pick<
    InstructionDefaults,
    'dataFolder' | 'systemFolder' | 'guideFile' | 'voice'
  >,
): string {
  return [
    dataFolderNote(defaults.dataFolder),
    systemFolderNote(note, defaults),
    ...(defaults.voice ? [VOICE_NOTE] : []),
  ].join('\n\n');
}

/**
 * Tells Pero, when it can record voice messages, how to send one: the
 * words in a `<voice>` block, which the Channel adapter records.
 */
export const VOICE_NOTE =
  'You can answer with a voice message: put what to say in a ' +
  '<voice>…</voice> block in your answer. Pero records it and sends it as ' +
  'a voice message, and the rest of your answer as text, in order. Send ' +
  'one when the owner asks for it, or when their note or Workflow asks for ' +
  'it; otherwise answer in text. Write what you say to be heard: plain ' +
  'sentences without Markdown, links, lists, tables, or code, and under ' +
  '4,000 characters. Voice messages the owner sends reach you as their ' +
  'transcript.';

/**
 * Tells Pero, which works in the workspace unless a note names a folder,
 * where the owner's notes are and where its own go.
 */
export function dataFolderNote(dataFolder: string): string {
  return (
    `The owner's notes are in the data folder, ${dataFolder}. ` +
    'Keep the notes and other files you write for them there, ' +
    'unless they ask for another place.'
  );
}

/**
 * Tells Pero where it answers and where its settings are, so that it can
 * change them when asked, and where the guide to them is, which it reads
 * before changing any or explaining how Pero works.
 */
export function systemFolderNote(
  note: Pick<ChannelNote, 'title' | 'file'>,
  {
    systemFolder,
    guideFile,
  }: Pick<InstructionDefaults, 'systemFolder' | 'guideFile'>,
): string {
  const own =
    note.file === null
      ? `This Channel has no note of its own yet; Pero writes one in ${join(systemFolder, NOTE_FOLDERS.channel)}.`
      : `This Channel's own settings and instructions are the note ${join(systemFolder, note.file)}.`;
  return (
    `You are Pero, the assistant that answers the owner in Telegram, ` +
    `here in the Channel ${note.title}. ${own} Your personality is in ` +
    `${join(systemFolder, PERSONA_NOTE)} and your general instructions in ` +
    `${join(systemFolder, INSTRUCTIONS_NOTE)}. Pero's defaults are in ` +
    `${join(systemFolder, PERO_NOTE)}, and its Workflows, tasks run on a ` +
    `schedule, are notes in ${join(systemFolder, NOTE_FOLDERS.workflow)}. ` +
    `Before you create or change a Channel note, a Workflow, or the ` +
    `defaults, or explain how Pero works, read ${guideFile}.`
  );
}
