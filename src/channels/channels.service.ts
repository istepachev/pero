import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { findAgent } from '../agents/agents.service.js';
import { InvalidInputError } from '../common/errors.js';
import { DefinitionIds } from '../definitions/definition-ids.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { SessionService } from '../sessions/session.service.js';
import { findChannel } from './channel-views.service.js';

/** What an assignment changed. */
export interface Assignment {
  /** The Agent the Channel had before. */
  from: string;
  /** The Agent it has now. */
  to: string;
  /** True when it already had that Agent, so nothing changed. */
  alreadyAssigned: boolean;
}

/**
 * Changes Channels, which onboarding creates: which Agent answers there,
 * and whether any does.
 */
@Injectable()
export class ChannelsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: SessionService,
    private readonly ids: DefinitionIds,
  ) {}

  /**
   * Points Channel `id` at the enabled Agent named `agentName` and closes
   * its Session, so the new Agent's first turn starts a fresh one with the
   * Channel's recent messages. Assigning the Agent it has changes nothing.
   */
  assign(id: number, agentName: string): Promise<Assignment> {
    return inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, id);
      const agent = await findAgent(manager, agentName);
      const from = await this.ids.agentName(channel.agentId);
      if (agent.id === channel.agentId) {
        return { from, to: agent.name, alreadyAssigned: true };
      }
      if (!agent.enabled) {
        throw new InvalidInputError(
          `Agent ${agent.name} is disabled; enable it first with pero agents enable ${agent.name}`,
        );
      }
      await this.sessions.closeActiveWithin(manager, id);
      await manager.getRepository(Channel).update(id, { agentId: agent.id });
      return { from, to: agent.name, alreadyAssigned: false };
    });
  }

  /**
   * Enables or disables Channel `id`. A disabled Channel ignores messages
   * and keeps its Agent and Sessions for when it is enabled again.
   */
  setEnabled(id: number, enabled: boolean): Promise<void> {
    return inTransaction(this.dataSource, async (manager) => {
      await findChannel(manager, id);
      await manager.getRepository(Channel).update(id, { enabled });
    });
  }
}
