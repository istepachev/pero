import type { Provider, ProviderOptions } from '../config/provider-options.js';
import type { ToolPolicy } from '../config/tool-policy.js';
import type { AgentDefinition, Defaults } from '../settings/definitions.js';

/** What a runtime needs from an Agent, with defaults already applied. */
export interface ResolvedAgent {
  name: string;
  provider: Provider;
  providerOptions: ProviderOptions;
  workingDirectory: string;
  instructions: string;
  toolPolicy: ToolPolicy;
  /** Whether a Codex Agent may work in a folder outside a Git repository. */
  codexSkipGitRepoCheck: boolean;
  enabled: boolean;
}

/** `agent` as a runtime runs it, with the shared instructions composed in. */
export function resolveAgent(
  agent: AgentDefinition,
  defaults: Pick<Defaults, 'sharedInstructions'>,
): ResolvedAgent {
  return {
    name: agent.name,
    provider: agent.provider,
    providerOptions: agent.providerOptions,
    workingDirectory: agent.workingDirectory,
    instructions: composeInstructions(agent, defaults),
    toolPolicy: { permissions: agent.permissions },
    codexSkipGitRepoCheck: agent.skipGitRepoCheck,
    enabled: agent.enabled,
  };
}

/**
 * The instructions sent to the runtime: the shared instructions, unless the
 * Agent opts out, then the Agent's own, separated by a blank line. Empty
 * parts are left out.
 */
export function composeInstructions(
  agent: { instructions: string | null; sharedInstructions: boolean },
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
