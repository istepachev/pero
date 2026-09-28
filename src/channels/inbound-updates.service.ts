import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { InboundUpdate } from '../persistence/entities/inbound-update.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import { inTransaction } from '../persistence/transaction.js';

/**
 * How long an update ID is remembered. Telegram keeps an undelivered update
 * for 24 hours, so a week covers any redelivery.
 */
export const INBOUND_UPDATE_RETENTION_DAYS = 7;

/** How often claiming also removes expired update IDs. */
export const INBOUND_UPDATE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Deduplicates updates an integration delivers more than once. An update
 * is claimed once and never again, even when the daemon stopped before
 * handing it on: a lost update beats a turn run twice.
 */
@Injectable()
export class InboundUpdates {
  private lastPrunedAt: number | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Records the update; false when it was seen before. */
  claim(integrationKind: IntegrationKind, updateId: string): Promise<boolean> {
    return inTransaction(this.dataSource, async (manager) => {
      await this.pruneWhenDue(manager);
      const repo = manager.getRepository(InboundUpdate);
      const key = { integrationKind, externalUpdateId: updateId };
      if (await repo.existsBy(key)) return false;
      await repo.insert(key);
      return true;
    });
  }

  /**
   * Marks a claimed update handed on, together with `alongside` in the same
   * transaction when given, such as recording the message it carried.
   */
  markProcessed(
    integrationKind: IntegrationKind,
    updateId: string,
  ): Promise<void>;
  markProcessed<T>(
    integrationKind: IntegrationKind,
    updateId: string,
    alongside: (manager: EntityManager) => Promise<T>,
  ): Promise<T>;
  markProcessed<T>(
    integrationKind: IntegrationKind,
    updateId: string,
    alongside?: (manager: EntityManager) => Promise<T>,
  ): Promise<T | undefined> {
    return inTransaction(this.dataSource, async (manager) => {
      await manager
        .getRepository(InboundUpdate)
        .update(
          { integrationKind, externalUpdateId: updateId },
          { status: 'processed' },
        );
      return alongside?.(manager);
    });
  }

  private async pruneWhenDue(manager: EntityManager): Promise<void> {
    const now = Date.now();
    if (
      this.lastPrunedAt !== null &&
      now - this.lastPrunedAt < INBOUND_UPDATE_PRUNE_INTERVAL_MS
    ) {
      return;
    }
    this.lastPrunedAt = now;
    await manager.query(
      `DELETE FROM "inbound_updates" WHERE "received_at" < ` +
        `datetime('now', '-${INBOUND_UPDATE_RETENTION_DAYS} days')`,
    );
  }
}
