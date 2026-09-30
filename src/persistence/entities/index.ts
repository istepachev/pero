import { AllowedChat } from './allowed-chat.entity.js';
import { Channel } from './channel.entity.js';
import { InboundUpdate } from './inbound-update.entity.js';
import { LegacyChannelAgent } from './legacy-channel-agent.entity.js';
import { Message } from './message.entity.js';
import { Notification } from './notification.entity.js';
import { ScheduleState } from './schedule-state.entity.js';
import { Session } from './session.entity.js';
import { Trigger } from './trigger.entity.js';
import { WorkflowNotificationTarget } from './workflow-notification-target.entity.js';
import { WorkflowRun } from './workflow-run.entity.js';
import { Workflow } from './workflow.entity.js';

/** Every entity, listed explicitly so the build needs no file globbing. */
export const ENTITIES = [
  Channel,
  Session,
  Workflow,
  Trigger,
  WorkflowRun,
  WorkflowNotificationTarget,
  Notification,
  InboundUpdate,
  AllowedChat,
  Message,
  ScheduleState,
  LegacyChannelAgent,
];
