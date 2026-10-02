import type { ChannelNote } from './snapshot.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * Where a value comes from: the note itself, `Pero.md`, or Pero's own
 * default because neither sets it.
 */
export const VALUE_ORIGINS = ['note', 'pero', 'default'] as const;

export type ValueOrigin = (typeof VALUE_ORIGINS)[number];

/** Where a Channel note's values that `Pero.md` can set come from. */
export interface ChannelOrigins {
  provider: ValueOrigin;
  model: ValueOrigin;
  effort: ValueOrigin;
  permissions: ValueOrigin;
  /** Its own `working-directory`, or else the workspace. */
  workingDirectory: 'note' | 'workspace';
}

/**
 * Where each of `channel`'s values comes from, given `peroProperties`,
 * the properties the `Pero.md` in use sets.
 */
export function channelOrigins(
  channel: Pick<ChannelNote, 'provider' | 'note'>,
  peroProperties: ReadonlySet<string>,
): ChannelOrigins {
  const { note } = channel;
  const from = (own: unknown, property: string): ValueOrigin =>
    own !== null ? 'note' : peroProperties.has(property) ? 'pero' : 'default';
  return {
    provider: from(note.provider, 'provider'),
    model: from(note.model, `${channel.provider}-model`),
    effort: from(note.effort, `${channel.provider}-effort`),
    permissions: from(note.permissions, 'permissions'),
    workingDirectory: note.workingDirectory === null ? 'workspace' : 'note',
  };
}
