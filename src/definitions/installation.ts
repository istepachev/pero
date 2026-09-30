import type { DataSource } from 'typeorm';
import { Channel } from '../persistence/entities/channel.entity.js';
import { LegacyChannelAgent } from '../persistence/entities/legacy-channel-agent.entity.js';
import { ScheduleState } from '../persistence/entities/schedule-state.entity.js';
import { type Schedule, scheduleFingerprint } from '../scheduler/schedule.js';
import type {
  AgentDefinition,
  Defaults,
  WorkflowDefinition,
} from './definitions.js';
import {
  type LegacyTrigger,
  readLegacyAllowedChats,
  readLegacyDefinitions,
  readLegacyTriggers,
  readLegacyWorkflows,
} from './legacy-definitions.js';

// What `pero migrate` reads from a legacy installation's database, and the
// one change it makes to its copy. It runs in the CLI, outside Nest.

/** A Trigger of a Workflow, whatever its kind and whether it is enabled. */
export type InstallationTrigger = LegacyTrigger;

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
  const allowedChats = await readLegacyAllowedChats(dataSource);

  return {
    defaults: legacy.defaults,
    agents: legacy.agents,
    mainAgent: legacy.mainAgent,
    workflows: await readLegacyWorkflows(dataSource),
    triggers: await readLegacyTriggers(dataSource),
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
  /** One per schedule. */
  parts: { name: string; title: string; schedule: Schedule }[];
}

/**
 * Gives each part of each Workflow in `splits` its schedule's saved times,
 * so no run is missed or repeated once its note defines it: the times of
 * the Workflow's schedule move to the part's name. Past runs keep the old
 * name. All in one transaction.
 */
export async function splitWorkflowSchedules(
  dataSource: DataSource,
  splits: readonly ScheduleSplit[],
): Promise<void> {
  if (splits.length === 0) return;
  await dataSource.transaction(async (manager) => {
    const states = manager.getRepository(ScheduleState);
    for (const split of splits) {
      for (const part of split.parts) {
        await states.update(
          {
            workflowName: split.workflow,
            fingerprint: scheduleFingerprint(part.schedule),
          },
          { workflowName: part.name },
        );
      }
    }
  });
}
