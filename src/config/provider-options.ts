import { z } from 'zod';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

export const PROVIDERS = ['claude', 'codex'] as const;

export type Provider = (typeof PROVIDERS)[number];

// Values the SDKs accept: `effort` in @anthropic-ai/claude-agent-sdk 0.3 and
// `modelReasoningEffort` in @openai/codex-sdk 0.157.
export const CLAUDE_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const CODEX_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
] as const;

// null means "let the provider choose" for every option.
const model = z.string().trim().min(1, 'must not be empty').nullable();

export const claudeOptionsSchema = z.strictObject({
  model: model.default(null),
  effort: z.enum(CLAUDE_EFFORTS).nullable().default(null),
});

export const codexOptionsSchema = z.strictObject({
  model: model.default(null),
  effort: z.enum(CODEX_EFFORTS).nullable().default(null),
});

/**
 * Per-provider options copied into new Agents. A missing provider or option
 * takes the provider's own default, so adding one needs no migration.
 */
export const providerDefaultsSchema = z.strictObject({
  claude: claudeOptionsSchema.default({ model: null, effort: null }),
  codex: codexOptionsSchema.default({ model: null, effort: null }),
});

export type ClaudeOptions = z.infer<typeof claudeOptionsSchema>;
export type CodexOptions = z.infer<typeof codexOptionsSchema>;
export type ProviderDefaults = z.infer<typeof providerDefaultsSchema>;
