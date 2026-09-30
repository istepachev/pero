import type { DataSource } from 'typeorm';
import { AllowedChat } from '../persistence/entities/allowed-chat.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { LegacyChannelAgent } from '../persistence/entities/legacy-channel-agent.entity.js';
import { ScheduleState } from '../persistence/entities/schedule-state.entity.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { WorkflowNotificationTarget } from '../persistence/entities/workflow-notification-target.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { scheduleFingerprint } from '../triggers/schedule.js';
import { DefinitionIds } from './definition-ids.js';
import type {
  AgentDefinition,
  Defaults,
  WorkflowDefinition,
} from './definitions.js';
import { readLegacyDefinitions } from './legacy-definitions.js';
import { SqliteDefinitions } from './sqlite-definitions.js';

// What `pero migrate` reads from a legacy installation's database, and the
// one change it makes to its copy. It runs in the CLI, outside Nest.

/** A Trigger of a Workflow, whatever its kind and whether it is enabled. */
export interface InstallationTrigger {
  id: number;
  /** The name of its Workflow. */
  workflow: string;
  kind: 'schedule' | 'manual';
  /** A schedule's cron expression; null for a manual Trigger. */
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
}

/** A Channel Pero has seen, with the Agent it is assigned to. */
export interface InstallationChannel {
  id: number;
  /** `<chat_id>` for a chat's primary Channel, `<chat_id>:<topic_id>` for a topic. */
  key: string;
  /** The topic's title, or the chat's for a primary Channel. */
  title: string | null;
  /**
   * The name of the Agent it is assigned to; null when it has none, as a
   * Channel a workspace's daemon onboarded.
   */
  agent: string | null;
  enabled: boolean;
}

/** Everything the definitions of an installation say, by name. */
export interface Installation {
  defaults: Defaults;
  agents: AgentDefinition[];
  /** The name of the main Agent; null while none is chosen. */
  mainAgent: string | null;
  workflows: WorkflowDefinition[];
  /** Oldest first. */
  triggers: InstallationTrigger[];
  /** Telegram's, oldest first. */
  channels: InstallationChannel[];
  /** Rows of the `allowed_chats` table not yet moved into `config.yaml`. */
  allowedChats: { chatKey: string; title: string | null }[];
}

/** The definitions the database `dataSource` holds, at the current schema. */
export async function readInstallation(
  dataSource: DataSource,
): Promise<Installation> {
  const legacy = await readLegacyDefinitions(dataSource);
  const ids = new DefinitionIds(dataSource);
  const workflowNames = await ids.workflowNames();

  const triggers = await dataSource
    .getRepository(Trigger)
    .find({ order: { id: 'ASC' } });
  const channels = await dataSource.getRepository(Channel).find({
    where: { integrationKind: 'telegram' },
    order: { id: 'ASC' },
  });
  // Kept apart from `channels` since plan step 8.2, which routes by notes.
  const routes = new Map(
    (await dataSource.getRepository(LegacyChannelAgent).find()).map((route) => [
      route.channelId,
      route,
    ]),
  );
  const allowedChats = await dataSource.getRepository(AllowedChat).find({
    where: { integrationKind: 'telegram' },
    order: { id: 'ASC' },
  });

  return {
    defaults: legacy.defaults,
    agents: legacy.agents,
    mainAgent: legacy.mainAgent,
    workflows: await new SqliteDefinitions(dataSource).workflows(),
    triggers: triggers.map((trigger) => ({
      id: trigger.id,
      workflow: workflowNames.get(trigger.workflowId)!,
      kind: trigger.kind,
      cron:
        typeof trigger.config.cron === 'string' ? trigger.config.cron : null,
      timezone: trigger.timezone,
      enabled: trigger.enabled,
    })),
    channels: channels.map((channel) => ({
      id: channel.id,
      key: channel.externalKey,
      title: channel.title,
      agent: routes.get(channel.id)?.agentName ?? null,
      enabled: routes.get(channel.id)?.enabled ?? true,
    })),
    allowedChats: allowedChats.map(({ chatKey, title }) => ({
      chatKey,
      title,
    })),
  };
}

/** A Workflow with several schedules, and the Workflows it becomes. */
export interface ScheduleSplit {
  workflow: string;
  /** One per schedule: the first also takes the Workflow's other Triggers. */
  parts: { name: string; title: string; trigger: number }[];
}

/**
 * Splits each Workflow in `splits` into one Workflow per schedule, as its
 * notes do: each part gets a copy of the Workflow with its notification
 * targets, its one schedule Trigger, and that schedule's saved times, so
 * no run is missed or repeated. The Workflow's other Triggers go to the
 * first part. Past runs keep the old name. All in one transaction.
 */
export async function splitWorkflowSchedules(
  dataSource: DataSource,
  splits: readonly ScheduleSplit[],
): Promise<void> {
  if (splits.length === 0) return;
  await dataSource.transaction(async (manager) => {
    const workflows = manager.getRepository(Workflow);
    const triggers = manager.getRepository(Trigger);
    const targets = manager.getRepository(WorkflowNotificationTarget);
    const states = manager.getRepository(ScheduleState);

    for (const split of splits) {
      const original = await workflows.findOneByOrFail({
        name: split.workflow,
      });
      const channels = await targets.findBy({ workflowId: original.id });
      const own = await triggers.findBy({ workflowId: original.id });
      for (const [index, part] of split.parts.entries()) {
        const { id: workflowId } = await workflows.save(
          workflows.create({
            name: part.name,
            title: part.title,
            agentName: original.agentName,
            inputTemplate: original.inputTemplate,
            history: original.history,
            enabled: original.enabled,
            concurrencyPolicy: original.concurrencyPolicy,
            maxAttempts: original.maxAttempts,
          }),
        );
        if (channels.length > 0) {
          await targets.insert(
            channels.map(({ channelId }) => ({ workflowId, channelId })),
          );
        }
        const moved = own.filter((trigger) =>
          index === 0
            ? !split.parts.some((other) => other.trigger === trigger.id) ||
              trigger.id === part.trigger
            : trigger.id === part.trigger,
        );
        for (const trigger of moved) {
          await triggers.update(trigger.id, { workflowId });
        }
        const schedule = own.find((trigger) => trigger.id === part.trigger)!;
        await states.update(
          {
            workflowName: split.workflow,
            fingerprint: scheduleFingerprint({
              cron: schedule.config.cron as string,
              timezone: schedule.timezone!,
            }),
          },
          { workflowName: part.name },
        );
      }
      await workflows.delete(original.id);
    }
  });
}
