import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { ChannelNote } from '../system-files/snapshot.js';
import { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';

/** How full a Session's context is, in tokens, and its model's window. */
export interface ContextUsage {
  tokens: number;
  /** Null when the provider doesn't say. */
  window: number | null;
}

/**
 * Whether a turn with `note` continues `session`: only while the Channel's
 * note keeps the provider and effective working directory the Session
 * began with.
 */
export function resumes(
  session: Pick<Session, 'provider' | 'workingDirectory'>,
  note: Pick<ChannelNote, 'provider' | 'workingDirectory'>,
): boolean {
  return (
    session.provider === note.provider &&
    session.workingDirectory === note.workingDirectory
  );
}

/**
 * The conversational context of each Channel: one active Session per
 * Channel, resumed only while its note keeps the provider and effective
 * working directory the Session began with. A Session records the name of
 * the note it began with.
 */
@Injectable()
export class SessionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * The Session a turn with `note` in Channel `channelId` runs in, inside
   * the caller's transaction. The active one resumes while its provider
   * and folder match the note's; otherwise it is closed and a fresh one,
   * with no provider session yet, takes its place. Model, effort, and
   * instructions may change within a Session.
   */
  async beginWithin(
    manager: EntityManager,
    channelId: number,
    note: Pick<ChannelNote, 'name' | 'provider' | 'workingDirectory'>,
  ): Promise<Session> {
    const sessions = manager.getRepository(Session);
    const active = await sessions.find({
      where: { channelId, status: 'active' },
      order: { id: 'DESC' },
    });
    const [latest] = active;
    if (active.length === 1 && resumes(latest!, note)) return latest!;
    // Closed first: at most one Session per Channel is active.
    for (const session of active) {
      await sessions.update(session.id, { status: 'closed' });
    }
    return sessions.save(
      sessions.create({
        channelId,
        agentName: note.name,
        provider: note.provider,
        workingDirectory: note.workingDirectory,
        providerSessionId: null,
      }),
    );
  }

  /**
   * Closes `session` and begins a fresh one in its place for `note`,
   * inside the caller's transaction, as when the provider no longer has
   * the conversation `session` would resume.
   */
  async replaceWithin(
    manager: EntityManager,
    session: Pick<Session, 'id' | 'channelId'>,
    note: Pick<ChannelNote, 'name' | 'provider' | 'workingDirectory'>,
  ): Promise<Session> {
    await manager
      .getRepository(Session)
      .update({ id: session.id, status: 'active' }, { status: 'closed' });
    return this.beginWithin(manager, session.channelId, note);
  }

  /**
   * Closes Channel `channelId`'s active Sessions inside the caller's
   * transaction, as `/new` does: its next turn starts a fresh one.
   */
  async closeChannelWithin(
    manager: EntityManager,
    channelId: number,
  ): Promise<number> {
    const { affected } = await manager
      .getRepository(Session)
      .update({ channelId, status: 'active' }, { status: 'closed' });
    return affected ?? 0;
  }

  /** Records how full `session`'s context is after a turn. */
  async recordContext(
    session: Pick<Session, 'id'>,
    usage: ContextUsage,
  ): Promise<void> {
    await inTransaction(this.dataSource, (manager) =>
      manager.getRepository(Session).update(session.id, {
        contextTokens: usage.tokens,
        contextWindow: usage.window,
      }),
    );
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
