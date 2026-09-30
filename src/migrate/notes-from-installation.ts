import { slugify } from '../config/slug.js';
import type {
  Installation,
  InstallationChannel,
  InstallationTrigger,
  ScheduleSplit,
} from '../definitions/installation.js';
import type { WorkflowDefinition } from '../definitions/definitions.js';
import { channelTopicLookup } from '../settings-notes/channel-topics.js';
import { formatNote, type NoteValue } from '../settings-files/note-writer.js';
import { NOTE_FOLDERS, PERO_NOTE } from '../settings-files/note-files.js';
import { dayValue, fromCron } from '../settings-files/schedule.js';
import {
  DEFAULT_HISTORY_CARRYOVER,
  DEFAULT_MAIN_AGENT,
  DEFAULT_MAX_CONCURRENT_RUNS,
  MAX_CONCURRENT_RUNS_LIMIT,
  type ChannelRef,
} from '../settings-files/schemas.js';
import { GENERAL_TOPIC, type TopicLookup } from '../settings-files/snapshot.js';

// Pure: no Nest or TypeORM. What `pero migrate` writes for an installation.

/** A note to write, at `path` inside the settings folder. */
export interface PlannedNote {
  path: string;
  text: string;
}

export interface NotesPlan {
  /** `Pero.md` first, then the Agents' and the Workflows' by name. */
  notes: PlannedNote[];
  /** Workflows with several schedules, which become one Workflow each. */
  splits: ScheduleSplit[];
  /** What changed in meaning, or has no place in notes, for the owner. */
  notices: string[];
  /** What stops the migration: topic titles that would route two ways. */
  conflicts: string[];
}

export interface PlanContext {
  /** Chats Pero serves, by chat ID; Channels of other chats are left out. */
  allowedChats: ReadonlySet<string>;
}

/**
 * The notes that describe `installation`: `Pero.md` from its settings, a
 * note for each Agent with the titles of the topics assigned to it, and
 * one for each Workflow, or one per schedule for a Workflow with several.
 * Names are kept: a note is named after its title only when that gives
 * the same name.
 */
export function planNotes(
  installation: Installation,
  context: PlanContext,
): NotesPlan {
  const notices: string[] = [];
  const conflicts: string[] = [];
  const { defaults } = installation;
  const mainAgent = installation.mainAgent ?? DEFAULT_MAIN_AGENT;
  const channels = installation.channels.filter((channel) =>
    context.allowedChats.has(chatOf(channel)),
  );
  const agentTitles = new Map(
    installation.agents.map((agent) => [
      agent.name,
      fileTitle(agent.title, agent.name),
    ]),
  );
  const agentTitle = (name: string) => agentTitles.get(name) ?? name;

  // Pero.md
  const pero: [string, NoteValue][] = [];
  if (defaults.provider !== 'claude')
    pero.push(['provider', defaults.provider]);
  for (const provider of ['claude', 'codex'] as const) {
    const { model, effort } = defaults.providerDefaults[provider];
    if (model !== null) pero.push([`${provider}-model`, model]);
    if (effort !== null) pero.push([`${provider}-effort`, effort]);
  }
  if (defaults.permissions !== 'ask') {
    pero.push(['permissions', defaults.permissions]);
  }
  pero.push(['timezone', defaults.timezone]);
  if (mainAgent !== DEFAULT_MAIN_AGENT) {
    pero.push(['main-agent', agentTitle(mainAgent)]);
  }
  if (defaults.historyCarryover !== DEFAULT_HISTORY_CARRYOVER) {
    pero.push(['history-carryover', defaults.historyCarryover]);
  }
  if (defaults.historyRetentionDays !== null) {
    pero.push(['history-retention-days', defaults.historyRetentionDays]);
  }
  let maxRuns = defaults.maxConcurrentRuns;
  if (maxRuns > MAX_CONCURRENT_RUNS_LIMIT) {
    notices.push(
      `max-concurrent-runs was ${maxRuns}; Pero.md allows at most ${MAX_CONCURRENT_RUNS_LIMIT}, so it is ${MAX_CONCURRENT_RUNS_LIMIT} now.`,
    );
    maxRuns = MAX_CONCURRENT_RUNS_LIMIT;
  }
  if (maxRuns !== DEFAULT_MAX_CONCURRENT_RUNS) {
    pero.push(['max-concurrent-runs', maxRuns]);
  }
  const notes: PlannedNote[] = [
    { path: PERO_NOTE, text: formatNote(pero, defaults.sharedInstructions) },
  ];

  // Topics, by the Agent each is assigned to.
  const chatTitles = new Map(
    channels
      .filter((channel) => !isTopic(channel))
      .map((channel) => [channel.key, channel.title ?? channel.key]),
  );
  const where = (channel: InstallationChannel) =>
    `${chatTitles.get(chatOf(channel)) ?? chatOf(channel)}/${channel.title ?? '?'}`;
  const topics = new Map<string, string[]>();
  const claims = new Map<string, Map<string, InstallationChannel[]>>();
  for (const channel of channels) {
    if (!isTopic(channel)) {
      if (channel.agent !== null && channel.agent !== mainAgent) {
        notices.push(
          `Chat ${chatTitles.get(channel.key)} was answered by ${channel.agent}; a chat's General topic and direct chats go to the main Agent, ${mainAgent}, now.`,
        );
      }
      continue;
    }
    if (channel.agent === null) {
      notices.push(
        `Topic ${where(channel)} (Channel ${channel.id}) had no Agent, so no note claims it: it goes to a new Agent or the main Agent.`,
      );
      continue;
    }
    if (channel.title === null) {
      notices.push(
        `Topic ${channel.key} (Channel ${channel.id}) has no title Pero has seen, so no note can claim it: it goes to a new Agent or the main Agent. Its Agent was ${channel.agent}.`,
      );
      continue;
    }
    if (channel.title.trim().toLowerCase() === GENERAL_TOPIC.toLowerCase()) {
      notices.push(
        `Topic ${where(channel)} can't be claimed by its title, which names a chat's General topic; its Agent was ${channel.agent}.`,
      );
      continue;
    }
    if (!channel.enabled) {
      notices.push(
        `Topic ${where(channel)} was disabled; ${channel.agent} answers it now. Disable the Agent, or take the topic out of its topics, to silence it.`,
      );
    }
    const key = channel.title.trim().toLowerCase();
    const byAgent = claims.get(key) ?? new Map<string, InstallationChannel[]>();
    byAgent.set(channel.agent, [
      ...(byAgent.get(channel.agent) ?? []),
      channel,
    ]);
    claims.set(key, byAgent);
    const own = topics.get(channel.agent) ?? [];
    if (!own.some((title) => title.toLowerCase() === key)) {
      own.push(channel.title.trim());
    }
    topics.set(channel.agent, own);
  }
  for (const byAgent of claims.values()) {
    if (byAgent.size < 2) continue;
    const [first] = [...byAgent.values()][0]!;
    const answered = [...byAgent]
      .map(
        ([agent, claimed]) =>
          `${agent} in ${claimed.map((channel) => where(channel)).join(', ')}`,
      )
      .join('; ');
    conflicts.push(
      `"${first!.title!.trim()}" is the title of topics answered by different Agents: ${answered}`,
    );
  }

  // Agents
  for (const agent of [...installation.agents].sort(byName)) {
    const properties: [string, NoteValue][] = [];
    const claimed = topics.get(agent.name) ?? [];
    if (claimed.length > 0) properties.push(['topics', claimed]);
    if (agent.provider !== defaults.provider) {
      properties.push(['provider', agent.provider]);
    }
    const inherited = defaults.providerDefaults[agent.provider];
    for (const option of ['model', 'effort'] as const) {
      const own = agent.providerOptions[option];
      if (own !== null && own !== inherited[option]) {
        properties.push([option, own]);
      } else if (own === null && inherited[option] !== null) {
        notices.push(
          `Agent ${agent.name} had no ${option} of its own, so its provider chose; it takes ${agent.provider}-${option} from Pero.md now: ${inherited[option]}.`,
        );
      }
    }
    if (agent.permissions !== defaults.permissions) {
      properties.push(['permissions', agent.permissions]);
    }
    if (agent.ownWorkingDirectory !== null) {
      properties.push(['working-directory', agent.ownWorkingDirectory]);
    }
    if (!agent.sharedInstructions) {
      properties.push(['shared-instructions', false]);
    }
    if (agent.skipGitRepoCheck) properties.push(['skip-git-repo-check', true]);
    if (!agent.enabled) properties.push(['enabled', false]);
    notes.push({
      path: `${NOTE_FOLDERS.agent}/${agentTitle(agent.name)}.md`,
      text: formatNote(properties, agent.instructions),
    });
  }

  // Workflows
  const lookup = channelTopicLookup(
    channels.map(({ id, key, title }) => ({ id, key, title })),
  );
  const byId = new Map(
    installation.channels.map((channel) => [channel.id, channel]),
  );
  const refs = (workflow: string, property: string, ids: readonly number[]) =>
    ids.flatMap((id) => {
      const channel = byId.get(id);
      if (channel === undefined || !context.allowedChats.has(chatOf(channel))) {
        notices.push(
          `Workflow ${workflow} named Channel ${id} in ${property}, in a chat Pero doesn't serve; it is left out.`,
        );
        return [];
      }
      return [channelRef(channel, lookup, chatTitles)];
    });
  const workflowNames = new Set(installation.workflows.map((w) => w.name));
  const splits: ScheduleSplit[] = [];

  for (const workflow of [...installation.workflows].sort(byName)) {
    const base = fileTitle(workflow.title, workflow.name);
    const common: [string, NoteValue][] = [
      ['agent', agentTitle(workflow.agent)],
    ];
    const targets = refs(workflow.name, 'its notifications', workflow.targets);
    if (targets.length > 0) common.push(['channel', targets]);
    const later: [string, NoteValue][] = [];
    const { history } = workflow;
    if (history !== null) {
      later.push(['history', true]);
      if (history.channels !== 'all') {
        const read = refs(workflow.name, 'history-channels', history.channels);
        if (read.length > 0) {
          later.push(['history-channels', read]);
        } else {
          // Leaving the property out would read every topic: more, not less.
          later.push(['enabled', false]);
          notices.push(
            `Workflow ${workflow.name} read history only from chats Pero doesn't serve, so it is disabled; set its history-channels and enable it.`,
          );
        }
      }
      if (history.messages !== 'people') {
        later.push(['history-messages', history.messages]);
      }
      if (history.hours !== null) later.push(['history-hours', history.hours]);
      if (history.runWhenEmpty) later.push(['run-when-empty', true]);
    }
    if (workflow.maxAttempts !== 1) {
      later.push(['max-attempts', workflow.maxAttempts]);
    }
    if (!workflow.enabled) later.push(['enabled', false]);

    const own = installation.triggers.filter(
      (trigger) =>
        trigger.workflow === workflow.name &&
        trigger.kind === 'schedule' &&
        trigger.cron !== null &&
        trigger.timezone !== null,
    );
    const enabled = own.filter((trigger) => trigger.enabled);
    const disabled = own.filter((trigger) => !trigger.enabled);
    const write = (title: string, schedule: [string, NoteValue][]) =>
      notes.push({
        path: `${NOTE_FOLDERS.workflow}/${title}.md`,
        text: formatNote([...common, ...schedule, ...later], workflow.input),
      });

    if (enabled.length === 0) {
      const kept = disabled[0];
      write(
        base,
        kept === undefined
          ? []
          : [
              ['trigger', 'manual'],
              ...scheduleProperties(kept, defaults.timezone),
            ],
      );
      dropped(workflow, disabled.slice(1), notices);
      continue;
    }
    dropped(workflow, disabled, notices);
    if (enabled.length === 1) {
      write(base, scheduleProperties(enabled[0]!, defaults.timezone));
      continue;
    }

    const parts = enabled.map((trigger, index) => ({
      name: `${workflow.name}-${index + 1}`,
      title: `${base} ${index + 1}`,
      trigger,
    }));
    for (const part of parts) {
      if (workflowNames.has(part.name) || slugify(part.title) !== part.name) {
        conflicts.push(
          `Workflow ${workflow.name} has ${parts.length} schedules, and would become one Workflow each, but ${part.name} can't be the name of one: ${workflowNames.has(part.name) ? 'another Workflow has it' : 'the name is too long'}. Rename one of them first.`,
        );
      }
      write(part.title, scheduleProperties(part.trigger, defaults.timezone));
    }
    splits.push({
      workflow: workflow.name,
      parts: parts.map(({ name, title, trigger }) => ({
        name,
        title,
        schedule: { cron: trigger.cron!, timezone: trigger.timezone! },
      })),
    });
    notices.push(
      `Workflow ${workflow.name} has ${parts.length} schedules, and a note holds one: it is ${parts.map((part) => part.name).join(', ')} now. Its past runs keep the name ${workflow.name}.`,
    );
  }

  return { notes, splits, notices, conflicts };
}

/**
 * The title a note is written under: `title` when it makes the name
 * `name` and is fit to be a file name, otherwise the name itself.
 */
export function fileTitle(title: string | null, name: string): string {
  const trimmed = title?.trim() ?? '';
  return trimmed !== '' &&
    slugify(trimmed) === name &&
    !/[/\\:*?"<>|\0]/.test(trimmed) &&
    !/^[._]/.test(trimmed)
    ? trimmed
    : name;
}

/**
 * How a Workflow note names `channel`: by its topic title, or `General`,
 * when that finds exactly it; then as `<chat title>/<topic title>`; and
 * by its Channel ID otherwise.
 */
function channelRef(
  channel: InstallationChannel,
  lookup: TopicLookup,
  chatTitles: ReadonlyMap<string, string>,
): ChannelRef {
  const topic = isTopic(channel)
    ? channel.title
    : chatOf(channel).startsWith('-')
      ? GENERAL_TOPIC
      : null;
  if (topic !== null) {
    const chat = chatTitles.get(chatOf(channel)) ?? chatOf(channel);
    for (const ref of [topic, `${chat}/${topic}`]) {
      const found = lookup.resolve(ref);
      if (found.kind === 'ok' && found.channel.id === channel.id) return ref;
    }
  }
  return channel.id;
}

/** The properties of a Workflow note for schedule `trigger`. */
function scheduleProperties(
  trigger: InstallationTrigger,
  timezone: string,
): [string, NoteValue][] {
  const properties: [string, NoteValue][] = [];
  const wallClock = fromCron(trigger.cron!);
  if (wallClock === null) {
    properties.push(['cron', trigger.cron!]);
  } else {
    const day = dayValue(wallClock.days);
    if (day !== null) properties.push(['day', day]);
    properties.push([
      'hour',
      wallClock.hours.length === 1 ? wallClock.hours[0]! : [...wallClock.hours],
    ]);
    if (wallClock.minute !== 0) properties.push(['minute', wallClock.minute]);
  }
  if (trigger.timezone !== timezone) {
    properties.push(['timezone', trigger.timezone!]);
  }
  return properties;
}

function dropped(
  workflow: WorkflowDefinition,
  triggers: readonly InstallationTrigger[],
  notices: string[],
): void {
  for (const trigger of triggers) {
    notices.push(
      `Workflow ${workflow.name} had a disabled schedule, ${trigger.cron} in ${trigger.timezone}; a note has no place for it, so it is left out.`,
    );
  }
}

function isTopic(channel: InstallationChannel): boolean {
  return channel.key.includes(':');
}

function chatOf(channel: InstallationChannel): string {
  return channel.key.split(':')[0]!;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
