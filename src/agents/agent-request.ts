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

/** `agent`'s part of a runtime request, with the shared instructions composed in. */
export function agentRequest(
  agent: Agent,
  defaults: { sharedInstructions: string | null },
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
 * The instructions sent to the runtime: the shared instructions, unless the
 * Agent opts out, then the Agent's own, separated by a blank line. Empty
 * parts are left out.
 */
export function composeInstructions(
  agent: Pick<Agent, 'instructions' | 'sharedInstructions'>,
  defaults: { sharedInstructions: string | null },
): string {
  const parts = [
    agent.sharedInstructions ? defaults.sharedInstructions : null,
    agent.instructions,
  ];
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
}
