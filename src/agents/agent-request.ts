import type { RuntimeRequest } from '../runtimes/agent-runtime.js';
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
 * The instructions sent to the runtime: where the data folder is, the
 * shared instructions unless the Agent opts out, then the Agent's own,
 * separated by blank lines. Empty parts are left out.
 */
export function composeInstructions(
  agent: Pick<Agent, 'instructions' | 'sharedInstructions'>,
  defaults: InstructionDefaults,
): string {
  const parts = [
    dataFolderNote(defaults.dataFolder),
    agent.sharedInstructions ? defaults.sharedInstructions : null,
    agent.instructions,
  ];
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
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
