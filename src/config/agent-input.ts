import { z } from 'zod';
import { PROVIDERS, providerOptionsPatchSchema } from './provider-options.js';
import { slugSchema, titleSchema } from './slug.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

const agentFields = {
  title: titleSchema.optional(),
  /** Omitted on creation: the default provider. */
  provider: z.enum(PROVIDERS).optional(),
  /** Merged onto the provider defaults, or onto the Agent's current options. */
  providerOptions: providerOptionsPatchSchema.optional(),
  instructions: z.string().nullable().optional(),
  /** An absolute folder of the Agent's own; null follows the default. */
  workingDirectory: z.string().nullable().optional(),
  useSharedInstructions: z.boolean().optional(),
  codexSkipGitRepoCheck: z.boolean().optional(),
};

/** A new Agent; omitted fields come from the installation defaults. */
export const agentCreateSchema = z.strictObject({
  name: slugSchema,
  ...agentFields,
});

/** Changes to an Agent; an omitted field keeps its value. */
export const agentEditSchema = z.strictObject({
  ...agentFields,
  enabled: z.boolean().optional(),
});

export type AgentCreate = z.input<typeof agentCreateSchema>;
export type AgentEdit = z.input<typeof agentEditSchema>;
