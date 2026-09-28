import { z } from 'zod';
import type { ResolvedAgent } from '../agents/agents.service.js';
import {
  PROVIDERS,
  providerOptionsSchema,
} from '../config/provider-options.js';
import { toolPolicySchema } from '../config/tool-policy.js';
import { HISTORY_MESSAGES } from '../config/workflow-input.js';

/**
 * The window of Channel history a run reads, fixed when the executor
 * claims it, and what it reads there. A retry reads the same window; the
 * Workflow's next run starts after `untilId`. Messages are bounded by ID,
 * since `created_at` has whole seconds.
 */
export const historyWindowSchema = z.object({
  channels: z.union([z.literal('all'), z.array(z.int())]),
  messages: z.enum(HISTORY_MESSAGES),
  runWhenEmpty: z.boolean(),
  /** The last message of the previous window; null for a first window. */
  afterId: z.int().nullable(),
  /** Where a first or fixed window starts; null after an earlier window. */
  since: z.iso.datetime().nullable(),
  /** The latest message when the run was claimed. */
  untilId: z.int(),
});

export type HistoryWindowSnapshot = z.infer<typeof historyWindowSchema>;

/** A history window with how many of its messages the input carried. */
export const historyReadSchema = historyWindowSchema.extend({
  /** How many messages the window holds. */
  count: z.int().nonnegative(),
  /** How many of the oldest the input left out to fit its budget. */
  dropped: z.int().nonnegative(),
});

export type HistoryRead = z.infer<typeof historyReadSchema>;

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
  /** What the run sends the Agent, with any history already rendered. */
  input: z.string(),
  /** The Channel history the input carries; absent when it reads none. */
  history: historyReadSchema.optional(),
});

export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;

/** The snapshot of `agent`'s settings with `input` and its `history`. */
export function executionSnapshot(
  agent: ResolvedAgent,
  input: string,
  history?: HistoryRead,
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
    ...(history === undefined ? {} : { history }),
  };
}
