import { z } from 'zod';
import type { ResolvedAgent } from '../agents/agents.service.js';
import {
  PROVIDERS,
  providerOptionsSchema,
} from '../config/provider-options.js';
import { toolPolicySchema } from '../config/tool-policy.js';

/**
 * What a Workflow Run executes with, captured when the executor claims it:
 * the Agent's resolved settings and the input. The run uses this copy, so
 * later edits to the Agent or the Workflow leave it alone.
 */
export const executionSnapshotSchema = z.object({
  agentId: z.int(),
  agentName: z.string(),
  provider: z.enum(PROVIDERS),
  providerOptions: providerOptionsSchema,
  /** The effective folder, already resolved. */
  workingDirectory: z.string(),
  /** Shared and own instructions, already composed. */
  instructions: z.string(),
  toolPolicy: toolPolicySchema,
  codexSkipGitRepoCheck: z.boolean(),
  /** What the run sends the Agent. */
  input: z.string(),
});

export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;

/** The snapshot of `agent`'s settings with `input`. */
export function executionSnapshot(
  agent: ResolvedAgent,
  input: string,
): ExecutionSnapshot {
  return {
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.provider,
    providerOptions: agent.providerOptions,
    workingDirectory: agent.workingDirectory,
    instructions: agent.instructions,
    toolPolicy: agent.toolPolicy,
    codexSkipGitRepoCheck: agent.codexSkipGitRepoCheck,
    input,
  };
}
