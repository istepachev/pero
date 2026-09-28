import type { ResolvedAgent } from '../agents/agents.service.js';
import type { NextTurn } from '../control/protocol.js';
import type { Session } from '../persistence/entities/session.entity.js';
import { resumes } from './session.service.js';

export interface NextTurnContext {
  /** Whether the Channel has messages a fresh Session would start with. */
  hasHistory: boolean;
  /** The `history-carryover` setting; 0 turns carry-over off. */
  carryover: number;
}

/**
 * What the next turn of `agent` in a Channel does with its active Session,
 * `active` (null when there is none), as `SessionService.beginWithin` and
 * `AgentManager` will: resume it, or start a provider session that begins
 * with the Channel's recent messages.
 */
export function nextTurn(
  active: Pick<
    Session,
    'id' | 'provider' | 'workingDirectory' | 'providerSessionId'
  > | null,
  agent: Pick<ResolvedAgent, 'provider' | 'workingDirectory'>,
  { hasHistory, carryover }: NextTurnContext,
): NextTurn {
  const carriesOver = hasHistory && carryover > 0;
  if (active === null) {
    return turn('new', null, null, null, carriesOver);
  }
  if (!resumes(active, agent)) {
    return active.provider === agent.provider
      ? turn('fresh', 'folder', active.workingDirectory, active.id, carriesOver)
      : turn('fresh', 'provider', active.provider, active.id, carriesOver);
  }
  return active.providerSessionId === null
    ? turn('restart', null, null, active.id, carriesOver)
    : turn('resume', null, null, active.id, false);
}

function turn(
  kind: NextTurn['kind'],
  reason: NextTurn['reason'],
  from: string | null,
  sessionId: number | null,
  carriesOver: boolean,
): NextTurn {
  return { kind, reason, from, sessionId, carriesOver };
}
