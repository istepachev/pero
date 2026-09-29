import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { ResolvedAgent } from '../agents/agents.service.js';
import { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';

/**
 * Whether a turn of `agent` continues `session`: only while the Agent keeps
 * the provider and effective working directory the Session began with.
 */
export function resumes(
  session: Pick<Session, 'provider' | 'workingDirectory'>,
  agent: Pick<ResolvedAgent, 'provider' | 'workingDirectory'>,
): boolean {
  return (
    session.provider === agent.provider &&
    session.workingDirectory === agent.workingDirectory
  );
}

/**
 * The conversational context of each Channel with its Agent: one active
 * Session per Channel and Agent, resumed only while the Agent keeps the
 * provider and effective working directory the Session began with.
 */
@Injectable()
export class SessionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * The Session a turn of `agent` in Channel `channelId` runs in, inside
   * the caller's transaction. The active one resumes while its provider
   * and folder match the Agent's; otherwise it is closed and a fresh one,
   * with no provider session yet, takes its place. Model, effort, and
   * instructions may change within a Session.
   */
  async beginWithin(
    manager: EntityManager,
    channelId: number,
    agent: Pick<ResolvedAgent, 'id' | 'provider' | 'workingDirectory'>,
  ): Promise<Session> {
    const sessions = manager.getRepository(Session);
    const active = await sessions.findOneBy({
      channelId,
      agentId: agent.id,
      status: 'active',
    });
    if (active !== null && resumes(active, agent)) return active;
    // Closed first: at most one Session per Channel and Agent is active.
    if (active !== null) {
      await sessions.update(active.id, { status: 'closed' });
    }
    return sessions.save(
      sessions.create({
        channelId,
        agentId: agent.id,
        provider: agent.provider,
        workingDirectory: agent.workingDirectory,
        providerSessionId: null,
      }),
    );
  }

  /**
   * Closes `session` and begins a fresh one in its place for `agent`,
   * inside the caller's transaction, as when the provider no longer has
   * the conversation `session` would resume.
   */
  async replaceWithin(
    manager: EntityManager,
    session: Pick<Session, 'id' | 'channelId'>,
    agent: Pick<ResolvedAgent, 'id' | 'provider' | 'workingDirectory'>,
  ): Promise<Session> {
    await manager
      .getRepository(Session)
      .update({ id: session.id, status: 'active' }, { status: 'closed' });
    return this.beginWithin(manager, session.channelId, agent);
  }

  /**
   * Closes the Channel's active Sessions inside the caller's transaction,
   * as when it is assigned another Agent: its next turn starts a fresh one.
   */
  async closeActiveWithin(
    manager: EntityManager,
    channelId: number,
  ): Promise<void> {
    await manager
      .getRepository(Session)
      .update({ channelId, status: 'active' }, { status: 'closed' });
  }

  /** Records the provider's ID for `session` when it changed. */
  async recordProviderSessionId(
    session: Pick<Session, 'id' | 'providerSessionId'>,
    providerSessionId: string,
  ): Promise<void> {
    if (session.providerSessionId === providerSessionId) return;
    await inTransaction(this.dataSource, (manager) =>
      manager.getRepository(Session).update(session.id, { providerSessionId }),
    );
    session.providerSessionId = providerSessionId;
  }
}
