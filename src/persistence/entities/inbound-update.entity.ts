import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { INTEGRATION_KINDS, type IntegrationKind, oneOf } from './sql.js';

export const INBOUND_UPDATE_STATUSES = ['received', 'processed'] as const;

export type InboundUpdateStatus = (typeof INBOUND_UPDATE_STATUSES)[number];

/**
 * An update already taken from an integration; the key rejects duplicates.
 * Kept only as long as deduplication needs it.
 */
@Entity('inbound_updates')
@Index('IDX_inbound_updates_received_at', ['receivedAt'])
@Check(
  'CHK_inbound_updates_integration_kind',
  oneOf('integration_kind', INTEGRATION_KINDS),
)
@Check('CHK_inbound_updates_status', oneOf('status', INBOUND_UPDATE_STATUSES))
export class InboundUpdate {
  @PrimaryColumn({ name: 'integration_kind', type: 'text' })
  integrationKind: IntegrationKind;

  /** The integration's update ID, as a string. */
  @PrimaryColumn({ name: 'external_update_id', type: 'text' })
  externalUpdateId: string;

  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;

  @Column({ type: 'text', default: 'received' })
  status: InboundUpdateStatus;
}
