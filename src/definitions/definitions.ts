import { NotFoundError } from '../common/errors.js';
import type {
  Provider,
  ProviderDefaults,
  ProviderOptions,
} from '../config/provider-options.js';
import type { PermissionMode } from '../config/tool-policy.js';
import type { WorkflowHistory } from '../config/workflow-input.js';
import type { Schedule } from '../scheduler/schedule.js';

/** Installation defaults that Agents and Pero's own limits follow. */
export interface Defaults {
  provider: Provider;
  /** Each provider's model and effort; null lets the provider choose. */
  providerDefaults: ProviderDefaults;
  permissions: PermissionMode;
  /** IANA time zone. */
  timezone: string;
  /** How many latest messages a fresh Session starts with; 0 carries none. */
  historyCarryover: number;
  /** Days of message history kept; null keeps all of it. */
  historyRetentionDays: number | null;
  /** Upper bound on Workflow Runs executing at once. */
  maxConcurrentRuns: number;
  /** Where Agents without a folder of their own work. */
  dataFolder: string;
  /** Placed before each opted-in Agent's own instructions; null for none. */
  sharedInstructions: string | null;
}

/** An Agent as it runs, with the defaults it follows applied. */
export interface AgentDefinition {
  name: string;
  /** Display name; null shows `name`. */
  title: string | null;
  provider: Provider;
  /** Model and effort for `provider`; null lets the provider choose. */
  providerOptions: ProviderOptions;
  permissions: PermissionMode;
  /** The folder it works in, absolute: its own, or the data folder. */
  workingDirectory: string;
  /** Its own folder; null follows the data folder. */
  ownWorkingDirectory: string | null;
  /** Its own instructions; null for none. */
  instructions: string | null;
  /** Whether the shared instructions precede its own. */
  sharedInstructions: boolean;
  /** Lets a Codex Agent work in a folder that is not a Git repository. */
  skipGitRepoCheck: boolean;
  enabled: boolean;
}

/** A Workflow as it runs. */
export interface WorkflowDefinition {
  name: string;
  /** Display name; null shows `name`. */
  title: string | null;
  /** The name of the Agent that runs it. */
  agent: string;
  /** What each run sends the Agent. */
  input: string;
  /** The Channel history each run reads; null reads none. */
  history: WorkflowHistory | null;
  /** The Channels, by ID, told of each run that finishes. */
  targets: number[];
  /** How many times a run of it may start in all. */
  maxAttempts: number;
  /** When it runs by itself: a cron expression in a time zone; null for never. */
  schedule: Schedule | null;
  enabled: boolean;
}

/** A Channel as routing sees it. */
export interface RouteQuery {
  /** A group's General topic, a group without topics, or a direct chat. */
  primary: boolean;
  /** The topic's title; null while Pero hasn't seen it. */
  title: string | null;
}

/**
 * A Channel, by its key, as routing sees it. A primary Channel's key is
 * its chat's; a topic's adds the topic's ID after a colon.
 */
export function routeQuery(channel: {
  externalKey: string;
  title: string | null;
}): RouteQuery {
  return {
    primary: !channel.externalKey.includes(':'),
    title: channel.title,
  };
}

/**
 * Why no Agent answers in a Channel. Files are notes' paths as the owner
 * reads them: inside the workspace, relative to it.
 */
export type Unanswered =
  /** Its Agent is disabled; `file` is its note. */
  | { kind: 'disabled'; agent: string; file: string }
  /** Several Agents' notes, in `files`, claim the topic. */
  | { kind: 'conflict'; title: string; files: string[] }
  /** Only notes that have errors and never loaded, in `files`, claim it. */
  | { kind: 'unloaded'; title: string; files: string[] }
  /** No Agent claims the topic; `note` is one that could. */
  | { kind: 'unclaimed'; title: string; note: string }
  /** Pero hasn't seen the topic's title yet, so nothing can claim it. */
  | { kind: 'untitled' }
  /** No note defines the main Agent; `note` is the one to add. */
  | { kind: 'no-main-agent'; agent: string; note: string };

/** Who answers in a Channel now: an enabled Agent, or no one and why. */
export type Route =
  | { kind: 'agent'; agent: AgentDefinition }
  | { kind: 'unanswered'; reason: Unanswered };

/**
 * What Pero is configured to run: the defaults, the Agents, and the
 * Workflows. Read-only; the owner's edits of notes change the definitions,
 * and `onChange` says when they have. Runtime code reads definitions only
 * through this.
 */
export abstract class Definitions {
  abstract defaults(): Promise<Defaults>;

  /** The Agent named `name`, in any case; null if none. */
  abstract agent(name: string): Promise<AgentDefinition | null>;

  /** Every Agent, by name. */
  abstract agents(): Promise<AgentDefinition[]>;

  /** The Agent primary Channels get; null while no note defines it. */
  abstract mainAgent(): Promise<AgentDefinition | null>;

  /** The name of the Agent primary Channels get, even while it is not defined. */
  abstract mainAgentName(): Promise<string>;

  /**
   * Who answers in `channel` now. A primary Channel gets the main Agent,
   * and a topic the Agent whose `topics` claims its title; `new-topics`
   * decides an unclaimed one.
   */
  abstract route(channel: RouteQuery): Promise<Route>;

  /** The Workflow named `name`, in any case; null if none. */
  abstract workflow(name: string): Promise<WorkflowDefinition | null>;

  /** Every Workflow, by name. */
  abstract workflows(): Promise<WorkflowDefinition[]>;

  /**
   * Calls `listener` after the definitions may have changed; returns a
   * function that stops the calls.
   */
  abstract onChange(listener: () => void): () => void;
}

/** The Agent named `name`; `NotFoundError` if none. */
export async function requireAgent(
  definitions: Definitions,
  name: string,
): Promise<AgentDefinition> {
  const agent = await definitions.agent(name);
  if (agent === null) throw new NotFoundError(`No Agent named ${name}`);
  return agent;
}

/** The Workflow named `name`; `NotFoundError` if none. */
export async function requireWorkflow(
  definitions: Definitions,
  name: string,
): Promise<WorkflowDefinition> {
  const workflow = await definitions.workflow(name);
  if (workflow === null) throw new NotFoundError(`No Workflow named ${name}`);
  return workflow;
}
