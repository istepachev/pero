import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { jsonObject, jsonTransformer } from '../json-transformer.js';
import { INTEGRATION_KINDS, type IntegrationKind, oneOf } from './sql.js';

/**
 * A conversation endpoint, such as one Telegram topic. Which Agent answers
 * there isn't stored: it follows the notes on each message.
 */
@Entity('channels')
@Index('UQ_channels_key', ['integrationKind', 'externalKey'], {
  unique: true,
})
@Check(
  'CHK_channels_integration_kind',
  oneOf('integration_kind', INTEGRATION_KINDS),
)
@Check('CHK_channels_address_json', `json_valid("address_json")`)
export class Channel {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ name: 'integration_kind', type: 'text' })
  integrationKind: IntegrationKind;

  /**
   * The address in one string, unique per integration. Telegram derives it
   * from the chat ID and the normalized topic ID.
   */
  @Column({ name: 'external_key', type: 'text' })
  externalKey: string;

  /**
   * The integration's structured address. Telegram IDs are strings, so no
   * 64-bit ID loses precision as a JavaScript number. JSON text.
   */
  @Column({
    name: 'address_json',
    type: 'text',
    transformer: jsonTransformer(jsonObject),
  })
  address: Record<string, unknown>;

  /** The topic or chat name, for display; null when the integration has none. */
  @Column({ type: 'text', nullable: true })
  title: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
