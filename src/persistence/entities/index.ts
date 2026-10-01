import { Channel } from './channel.entity.js';
import { InboundUpdate } from './inbound-update.entity.js';
import { Message } from './message.entity.js';
import { Notification } from './notification.entity.js';
import { ScheduleState } from './schedule-state.entity.js';
import { Session } from './session.entity.js';
import { WorkflowRun } from './workflow-run.entity.js';

/** Every entity, listed explicitly so the build needs no file globbing. */
export const ENTITIES = [
  Channel,
  Session,
  WorkflowRun,
  Notification,
  InboundUpdate,
  Message,
  ScheduleState,
];
