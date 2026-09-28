import { z } from 'zod';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

export const PROVIDERS = ['claude', 'codex'] as const;

export type Provider = (typeof PROVIDERS)[number];

// Values the SDKs accept: `effort` in @anthropic-ai/claude-agent-sdk 0.3 and
// `modelReasoningEffort` in @openai/codex-sdk 0.158.
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
const claudeEffort = z.enum(CLAUDE_EFFORTS).nullable();
const codexEffort = z.enum(CODEX_EFFORTS).nullable();

export const claudeOptionsSchema = z.strictObject({
  model: model.default(null),
  effort: claudeEffort.default(null),
});

export const codexOptionsSchema = z.strictObject({
  model: model.default(null),
  effort: codexEffort.default(null),
});

/** Each provider's options schema, to check options against their provider. */
export const PROVIDER_OPTIONS_SCHEMAS = {
  claude: claudeOptionsSchema,
  codex: codexOptionsSchema,
} as const;

/**
 * Per-provider options copied into new Agents. A missing provider or option
 * takes the provider's own default, so adding one needs no migration.
 */
export const providerDefaultsSchema = z.strictObject({
  claude: claudeOptionsSchema.default({ model: null, effort: null }),
  codex: codexOptionsSchema.default({ model: null, effort: null }),
});

/**
 * One Agent's options, valid for at least one provider. Matching them to the
 * Agent's own provider needs the provider too, so the Agent service does it.
 */
export const providerOptionsSchema = z.union([
  claudeOptionsSchema,
  codexOptionsSchema,
]);

// Changes to some options: an omitted option keeps its current value.
const claudeOptionsPatchSchema = z.strictObject({
  model: model.optional(),
  effort: claudeEffort.optional(),
});
const codexOptionsPatchSchema = z.strictObject({
  model: model.optional(),
  effort: codexEffort.optional(),
});

/** Changes to some provider defaults; the rest keep their values. */
export const providerDefaultsPatchSchema = z.strictObject({
  claude: claudeOptionsPatchSchema.optional(),
  codex: codexOptionsPatchSchema.optional(),
});

/**
 * Changes to one Agent's options, with any provider's effort level; the
 * result is checked against the Agent's provider once they are merged.
 * One object rather than a union, so errors name the offending option.
 */
export const providerOptionsPatchSchema = z.strictObject({
  model: model.optional(),
  effort: z
    .enum([...new Set([...CLAUDE_EFFORTS, ...CODEX_EFFORTS])])
    .nullable()
    .optional(),
});

/** `options` with each option `patch` sets replaced. */
export function mergeOptions(
  options: object,
  patch: object | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...options };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export type ClaudeOptions = z.infer<typeof claudeOptionsSchema>;
export type CodexOptions = z.infer<typeof codexOptionsSchema>;
export type ProviderOptions = z.infer<typeof providerOptionsSchema>;
export type ProviderDefaults = z.infer<typeof providerDefaultsSchema>;
export type ProviderDefaultsPatch = z.input<typeof providerDefaultsPatchSchema>;
export type ProviderOptionsPatch = z.input<typeof providerOptionsPatchSchema>;
