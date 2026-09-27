import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Channel } from './channel.entity.js';
import { Workflow } from './workflow.entity.js';

/** A Channel that a Workflow notifies; removed along with either. */
@Entity('workflow_notification_targets')
@Index('IDX_workflow_notification_targets_channel_id', ['channelId'])
export class WorkflowNotificationTarget {
  @PrimaryColumn({ name: 'workflow_id', type: 'integer' })
  workflowId: number;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'workflow_id',
    foreignKeyConstraintName: 'FK_workflow_notification_targets_workflow_id',
  })
  workflow?: Workflow;

  @PrimaryColumn({ name: 'channel_id', type: 'integer' })
  channelId: number;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'channel_id',
    foreignKeyConstraintName: 'FK_workflow_notification_targets_channel_id',
  })
  channel?: Channel;
}
