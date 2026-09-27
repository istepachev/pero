/** A CHECK expression that limits `column` to `values`. */
export function oneOf(column: string, values: readonly string[]): string {
  return `"${column}" IN (${values.map((value) => `'${value}'`).join(', ')})`;
}

/** Integrations that can carry a Channel; Telegram is the first. */
export const INTEGRATION_KINDS = ['telegram'] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
