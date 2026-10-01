import { join } from 'node:path';
import type { RuntimeRequest } from '../runtimes/agent-runtime.js';
import { NOTE_FOLDERS, PERO_NOTE } from '../settings-files/note-files.js';
import type { Agent } from '../settings-files/snapshot.js';

/** What a runtime request takes from the Agent that runs it. */
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

/** What composing an Agent's instructions takes from the defaults. */
export interface InstructionDefaults {
  /** Named in every Agent's instructions as where its notes go. */
  dataFolder: string;
  /** Where every Agent's instructions find its own note and `Pero.md`. */
  settingsFolder: string;
  /** The guide to Pero's settings that every Agent's instructions name. */
  guideFile: string;
  sharedInstructions: string | null;
}

/** `agent`'s part of a runtime request, with the shared instructions composed in. */
export function agentRequest(
  agent: Agent,
  defaults: InstructionDefaults,
): AgentRequest {
  return {
    instructions: composeInstructions(agent, defaults),
    providerOptions: { model: agent.model, effort: agent.effort },
    workingDirectory: agent.workingDirectory,
    skipGitRepoCheck: agent.skipGitRepoCheck,
    toolPolicy: { permissions: agent.permissions },
  };
}

/**
 * The instructions sent to the runtime: the Agent's context (where the data
 * folder is, and where its settings are), the shared instructions unless
 * the Agent opts out, then the Agent's own, separated by blank lines.
 * Empty parts are left out.
 */
export function composeInstructions(
  agent: Pick<Agent, 'title' | 'file' | 'instructions' | 'sharedInstructions'>,
  defaults: InstructionDefaults,
): string {
  const parts = [
    agentContext(agent, defaults),
    agent.sharedInstructions ? defaults.sharedInstructions : null,
    agent.instructions,
  ];
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
}

/**
 * What every Agent's instructions start with, whether or not it takes the
 * shared instructions: where the data folder is, and where its settings are.
 */
export function agentContext(
  agent: Pick<Agent, 'title' | 'file'>,
  defaults: Pick<
    InstructionDefaults,
    'dataFolder' | 'settingsFolder' | 'guideFile'
  >,
): string {
  return `${dataFolderNote(defaults.dataFolder)}\n\n${settingsNote(agent, defaults)}`;
}

/**
 * Tells the Agent, which works in the workspace unless its note names a
 * folder, where the owner's notes are and where its own go.
 */
export function dataFolderNote(dataFolder: string): string {
  return (
    `The owner's notes are in the data folder, ${dataFolder}. ` +
    'Keep the notes and other files you write for them there, ' +
    'unless they ask for another place.'
  );
}

/**
 * Tells the Agent who it is in Pero and where its settings are, so that it
 * can change them when asked, and where the guide to them is, which it
 * reads before changing any or explaining how Pero works.
 */
export function settingsNote(
  agent: Pick<Agent, 'title' | 'file'>,
  {
    settingsFolder,
    guideFile,
  }: Pick<InstructionDefaults, 'settingsFolder' | 'guideFile'>,
): string {
  return (
    `You are the Agent ${agent.title} of Pero, the service that runs you ` +
    'and answers the owner in Telegram. Your settings and instructions are ' +
    `the note ${join(settingsFolder, agent.file)}. Pero's defaults and the ` +
    'instructions every Agent shares are in ' +
    `${join(settingsFolder, PERO_NOTE)}, and its Workflows, tasks Agents ` +
    'run on a schedule, are notes in ' +
    `${join(settingsFolder, NOTE_FOLDERS.workflow)}. Before you create or ` +
    'change an Agent, a Workflow, or the defaults, or explain how Pero ' +
    `works, read ${guideFile}.`
  );
}
