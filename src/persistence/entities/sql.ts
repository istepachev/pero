/** A CHECK expression that limits `column` to `values`. */
export function oneOf(column: string, values: readonly string[]): string {
  return `"${column}" IN (${values.map((value) => `'${value}'`).join(', ')})`;
}

/**
 * A CHECK expression matching `slugSchema` in config/slug.ts. SQLite has no
 * regular expressions, so it rules out each non-slug shape instead.
 */
export function isSlug(column: string, maxLength: number): string {
  const c = `"${column}"`;
  return (
    `${c} <> '' AND length(${c}) <= ${maxLength} AND ` +
    `${c} NOT GLOB '*[^a-z0-9-]*' AND ${c} NOT GLOB '-*' AND ` +
    `${c} NOT GLOB '*-' AND ${c} NOT GLOB '*--*'`
  );
}

/** Integrations that can carry a Channel; Telegram is the first. */
export const INTEGRATION_KINDS = ['telegram'] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** Whether a chat is one person's direct chat with the bot or a group. */
export const CHAT_KINDS = ['private', 'group'] as const;

export type ChatKind = (typeof CHAT_KINDS)[number];

/** Whether a message came into a Channel or went out from Pero. */
export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;

export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * Who wrote a message: a person in the chat, the Channel's Agent, or Pero
 * itself, such as a welcome or a failure notice.
 */
export const MESSAGE_ORIGINS = ['user', 'agent', 'pero'] as const;

export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];
