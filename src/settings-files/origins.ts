import type { AgentDefinition } from './snapshot.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * Where a value comes from: the note itself, `Pero.md`, or Pero's own
 * default because neither sets it.
 */
export const VALUE_ORIGINS = ['note', 'pero', 'default'] as const;

export type ValueOrigin = (typeof VALUE_ORIGINS)[number];

/** Where an Agent's values that `Pero.md` can set come from. */
export interface AgentOrigins {
  provider: ValueOrigin;
  model: ValueOrigin;
  effort: ValueOrigin;
  permissions: ValueOrigin;
  /** Its own `working-directory`, or else the data folder. */
  workingDirectory: 'note' | 'data';
}

/**
 * Where each of `agent`'s values comes from, given `peroProperties`, the
 * properties the `Pero.md` in use sets.
 */
export function agentOrigins(
  agent: Pick<AgentDefinition, 'provider' | 'note'>,
  peroProperties: ReadonlySet<string>,
): AgentOrigins {
  const { note } = agent;
  const from = (own: unknown, property: string): ValueOrigin =>
    own !== null ? 'note' : peroProperties.has(property) ? 'pero' : 'default';
  return {
    provider: from(note.provider, 'provider'),
    model: from(note.model, `${agent.provider}-model`),
    effort: from(note.effort, `${agent.provider}-effort`),
    permissions: from(note.permissions, 'permissions'),
    workingDirectory: note.workingDirectory === null ? 'data' : 'note',
  };
}
