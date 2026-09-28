import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  CHAT_KINDS,
  type ChatKind,
  INTEGRATION_KINDS,
  type IntegrationKind,
  oneOf,
} from './sql.js';

/** A chat Pero serves; messages from any other chat never reach a Channel. */
@Entity('allowed_chats')
@Index('UQ_allowed_chats_key', ['integrationKind', 'chatKey'], {
  unique: true,
})
@Check(
  'CHK_allowed_chats_integration_kind',
  oneOf('integration_kind', INTEGRATION_KINDS),
)
@Check('CHK_allowed_chats_kind', oneOf('kind', CHAT_KINDS))
export class AllowedChat {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ name: 'integration_kind', type: 'text' })
  integrationKind: IntegrationKind;

  /** The integration's chat ID, as a string; Telegram's may exceed 2^53. */
  @Column({ name: 'chat_key', type: 'text' })
  chatKey: string;

  @Column({ type: 'text' })
  kind: ChatKind;

  /** The chat's name as last seen; null until a message shows it. */
  @Column({ type: 'text', nullable: true })
  title: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
