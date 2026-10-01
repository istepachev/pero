import { resolvePath } from '../config/bootstrap-config.js';
import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  type Provider,
} from '../config/provider-options.js';
import type { PermissionMode } from '../config/tool-policy.js';
import { parseNote, type ParsedNote } from './note.js';
import {
  isIgnoredPath,
  type NoteIdentity,
  noteIdentity,
  PERO_NOTE,
} from './note-files.js';
import type { NoteFile } from './scan.js';
import {
  type AgentNote,
  type ChannelRef,
  listing,
  type NoteResult,
  type PeroNote,
  readAgentNote,
  readPeroNote,
  readWorkflowNote,
  topicTitles,
  type WorkflowNote,
  type WorkflowNoteHistory,
} from './schemas.js';
import type { SettingsError } from './settings-error.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** Installation defaults, with the time zone settled. */
export interface Defaults extends Omit<
  PeroNote,
  'timezone' | 'sharedInstructions'
> {
  timezone: string;
}

/** An Agent as it runs: its note with `Pero.md`'s defaults applied. */
export interface AgentDefinition {
  name: string;
  title: string;
  /** Its note's path inside the settings folder. */
  file: string;
  topics: readonly string[];
  provider: Provider;
  model: string | null;
  effort: string | null;
  permissions: PermissionMode;
  /** Absolute. */
  workingDirectory: string;
  sharedInstructions: boolean;
  skipGitRepoCheck: boolean;
  enabled: boolean;
  instructions: string | null;
  /** What the note itself sets, to tell its values from the defaults. */
  note: AgentNote;
}

/** A Workflow as it runs. */
export interface WorkflowDefinition {
  name: string;
  title: string;
  file: string;
  /**
   * The Agent that runs it: its own `agent`, the one answering its first
   * `channel`, or the main Agent. Null when the first `channel` is a
   * Channel ID and no lookup was given to find out which topic that is.
   */
  agent: string | null;
  /** Null: it runs only by hand. */
  schedule: { cron: string; timezone: string } | null;
  channels: readonly ChannelRef[];
  history: WorkflowNoteHistory | null;
  /**
   * The Channels `channels` and `history-channels` name, by ID, once a
   * lookup found them; null without one.
   */
  resolved: ResolvedChannels | null;
  maxAttempts: number;
  enabled: boolean;
  input: string;
}

/** The Channels a Workflow's references name, by ID. */
export interface ResolvedChannels {
  /** Where each run's answer is posted, in the order `channel` names them. */
  targets: readonly number[];
  /** Whose history runs read: `all`, or those `history-channels` names. */
  history: 'all' | readonly number[];
}

/** Every setting from the notes, with references between them resolved. */
export interface SettingsSnapshot {
  defaults: Defaults;
  /** `Pero.md`'s body. */
  sharedInstructions: string | null;
  /**
   * The properties the `Pero.md` in use sets, to tell its values from
   * Pero's own defaults.
   */
  peroProperties: ReadonlySet<string>;
  agents: ReadonlyMap<string, AgentDefinition>;
  /** The name of the main Agent; its note may not exist yet. */
  mainAgent: string;
  workflows: ReadonlyMap<string, WorkflowDefinition>;
  /** Topic titles, lowercased, and the Agent each is answered by. */
  topicClaims: ReadonlyMap<string, string>;
  /** Topic titles, lowercased, that several Agents claim: none answers. */
  conflictedTopics: ReadonlySet<string>;
  /**
   * Topic titles, lowercased, that only Agent notes left out for errors
   * claim, with those notes' files: none answers until they load.
   */
  unloadedTopics: ReadonlyMap<string, readonly string[]>;
  /** Sorted by file. */
  errors: readonly SettingsError[];
}

/** A Channel a reference in a Workflow names. */
export interface ResolvedChannel {
  id: number;
  /** A General topic, a group without topics, or a direct chat. */
  primary: boolean;
  /** The topic title, for choosing the Agent that answers it. */
  title: string;
}

export type TopicResolution =
  | { kind: 'ok'; channel: ResolvedChannel }
  /** Nothing matches; `seen` lists the topics that exist, for the message. */
  | { kind: 'none'; seen: readonly string[] }
  /** Several match; `matches` names each as `<chat title>/<topic title>`. */
  | { kind: 'ambiguous'; matches: readonly string[] };

/** Finds the Channels Workflow references name, among those Pero has seen. */
export interface TopicLookup {
  resolve(ref: ChannelRef): TopicResolution;
}

export interface SnapshotContext {
  /** The workspace, which relative `working-directory` paths start from. */
  workspace: string;
  /** Absolute; where Agents work unless their note says otherwise. */
  dataFolder: string;
  homeDir: string;
  /** For `Pero.md` without a `timezone`. */
  hostTimeZone: string;
  /** Without one, as in CI, Channel references are checked for syntax only. */
  topics?: TopicLookup;
}

/** The topic title that means a group's General topic. */
export const GENERAL_TOPIC = 'General';

const EFFORTS_BY_PROVIDER: Readonly<Record<Provider, readonly string[]>> = {
  claude: CLAUDE_EFFORTS,
  codex: CODEX_EFFORTS,
};

/** A note read as its kind; a note that didn't parse has no `note`. */
interface Read<T> {
  file: string;
  identity: NoteIdentity;
  note: ParsedNote | null;
  result: NoteResult<T>;
}

/** A note read as its kind, before references to other notes resolve. */
export type NoteRead =
  | { kind: 'pero'; read: Read<PeroNote> }
  | { kind: 'agent'; read: Read<AgentNote> }
  | { kind: 'workflow'; read: Read<WorkflowNote> };

/** A note for `buildSnapshot`. */
export interface SnapshotNote extends NoteFile {
  /**
   * An earlier version of the note that read without errors, used in its
   * place while `text` has errors; they are still reported.
   */
  fallback?: string;
}

/**
 * `text` read as the note at `file`, on its own: its identity, properties,
 * and values. `errors` lists every problem found without looking at other
 * notes; `note` is null when the file isn't a note Pero knows.
 */
export function readNote(
  file: string,
  text: string,
): { note: NoteRead | null; errors: SettingsError[] } {
  const identified = noteIdentity(file);
  if (!identified.ok) return { note: null, errors: [identified.error] };
  const { identity } = identified;
  const parsed = parseNote(file, text);
  const note = parsed.ok ? parsed.note : null;
  const reading = <T>(
    reader: (file: string, note: ParsedNote) => NoteResult<T>,
  ): Read<T> => ({
    file,
    identity,
    note,
    result: parsed.ok ? reader(file, parsed.note) : parsed,
  });
  let read: NoteRead;
  switch (identity.kind) {
    case 'pero':
      read = { kind: 'pero', read: reading(readPeroNote) };
      break;
    case 'agent':
      read = { kind: 'agent', read: reading(readAgentNote) };
      break;
    case 'workflow':
      read = { kind: 'workflow', read: reading(readWorkflowNote) };
      break;
  }
  return {
    note: read,
    errors: read.read.result.ok ? [] : read.read.result.errors,
  };
}

/**
 * The snapshot `notes`, the settings folder's notes, describe. A note that
 * doesn't parse or validate is left out along with only the notes that
 * depend on it, and every problem is listed in `errors` with its file and
 * property. A broken `Pero.md` leaves the defaults, not the Agents, out.
 */
export function buildSnapshot(
  notes: readonly SnapshotNote[],
  context: SnapshotContext,
): SettingsSnapshot {
  const errors: SettingsError[] = [];
  const agentNotes: Read<AgentNote>[] = [];
  const workflowNotes: Read<WorkflowNote>[] = [];
  let pero: Read<PeroNote> | null = null;

  for (const { file, text, fallback } of notes) {
    if (isIgnoredPath(file)) continue;
    let { note, errors: found } = readNote(file, text);
    errors.push(...found);
    if (found.length > 0 && fallback !== undefined) {
      const previous = readNote(file, fallback);
      if (previous.errors.length === 0) note = previous.note;
    }
    switch (note?.kind) {
      case 'pero':
        pero = note.read;
        break;
      case 'agent':
        agentNotes.push(note.read);
        break;
      case 'workflow':
        workflowNotes.push(note.read);
        break;
    }
  }

  const peroNote = pero?.result.ok ? pero.result.value : defaultPeroNote();
  const peroProperties = new Set(
    pero?.result.ok
      ? Object.entries(pero.note?.properties ?? {})
          .filter(([, value]) => value !== null)
          .map(([key]) => key)
      : [],
  );
  const { timezone, sharedInstructions, ...peroDefaults } = peroNote;
  const defaults: Defaults = {
    ...peroDefaults,
    timezone: timezone ?? context.hostTimeZone,
  };

  // Names of Agent notes that exist but are left out, for notes naming them.
  const brokenAgents = new Set<string>();
  const agents = new Map<string, AgentDefinition>();
  for (const read of withUniqueNames(agentNotes, errors, brokenAgents)) {
    if (!read.result.ok) {
      brokenAgents.add(read.identity.name);
      continue;
    }
    const agent = defineAgent(read, read.result.value, defaults, context);
    if (typeof agent === 'string') {
      errors.push({ file: read.file, property: 'effort', message: agent });
      brokenAgents.add(read.identity.name);
      continue;
    }
    agents.set(agent.name, agent);
  }

  // Topic claims.
  const claimants = new Map<string, AgentDefinition[]>();
  for (const agent of agents.values()) {
    for (const title of agent.topics) {
      const key = title.toLowerCase();
      claimants.set(key, [...(claimants.get(key) ?? []), agent]);
    }
  }
  const topicClaims = new Map<string, string>();
  const conflictedTopics = new Set<string>();
  for (const [key, claiming] of claimants) {
    if (claiming.length === 1) {
      topicClaims.set(key, claiming[0]!.name);
      continue;
    }
    conflictedTopics.add(key);
    for (const agent of claiming) {
      const title = agent.topics.find((topic) => topic.toLowerCase() === key)!;
      const others = claiming
        .filter((other) => other !== agent)
        .map((other) => other.file);
      errors.push({
        file: agent.file,
        property: 'topics',
        message: `"${title}" is also claimed by ${listing(others)}, so neither answers there`,
      });
    }
  }

  // Topics only notes left out claim, as a note broken since Pero started.
  const unloadedTopics = new Map<string, string[]>();
  for (const read of agentNotes) {
    if (agents.get(read.identity.name)?.file === read.file) continue;
    for (const title of topicTitles(read.note?.properties.topics) ?? []) {
      const key = title.toLowerCase();
      if (claimants.has(key)) continue;
      const files = unloadedTopics.get(key) ?? [];
      if (!files.includes(read.file)) files.push(read.file);
      unloadedTopics.set(key, files);
    }
  }

  // The main Agent: the default one is created when a Channel first needs it.
  const mainAgent = defaults.mainAgent;
  if (pero?.note?.properties['main-agent'] != null && !agents.has(mainAgent)) {
    errors.push({
      file: PERO_NOTE,
      property: 'main-agent',
      message: brokenAgents.has(mainAgent)
        ? `the Agent note named ${mainAgent} has errors`
        : `no Agent note is named ${mainAgent}`,
    });
  }

  // Workflows.
  const resolver = new WorkflowResolver(
    agents,
    brokenAgents,
    topicClaims,
    conflictedTopics,
    mainAgent,
    context.topics,
  );
  const workflows = new Map<string, WorkflowDefinition>();
  for (const read of withUniqueNames(workflowNotes, errors, new Set())) {
    if (!read.result.ok) continue;
    const workflow = resolver.define(read, read.result.value, defaults);
    if (Array.isArray(workflow)) {
      errors.push(...workflow);
      continue;
    }
    workflows.set(workflow.name, workflow);
  }

  return Object.freeze({
    defaults: Object.freeze(defaults),
    sharedInstructions,
    peroProperties,
    agents,
    mainAgent,
    workflows,
    topicClaims,
    conflictedTopics,
    unloadedTopics,
    // Stable, so each file's errors keep the order they were found in.
    errors: Object.freeze(errors.sort((a, b) => compare(a.file, b.file))),
  });
}

function defaultPeroNote(): PeroNote {
  const result = readPeroNote(PERO_NOTE, { properties: {}, body: null });
  if (!result.ok) throw new Error('Pero.md defaults do not validate');
  return result.value;
}

/**
 * `reads` without the notes whose name another note of their kind also
 * has; each of those gets an error naming the others, and the name goes
 * in `duplicated`.
 */
function withUniqueNames<T>(
  reads: readonly Read<T>[],
  errors: SettingsError[],
  duplicated: Set<string>,
): Read<T>[] {
  const byName = new Map<string, Read<T>[]>();
  for (const read of reads) {
    byName.set(read.identity.name, [
      ...(byName.get(read.identity.name) ?? []),
      read,
    ]);
  }
  const unique: Read<T>[] = [];
  for (const [name, named] of byName) {
    if (named.length === 1) {
      unique.push(named[0]!);
      continue;
    }
    duplicated.add(name);
    for (const read of named) {
      const others = named
        .filter((other) => other !== read)
        .map((other) => other.file);
      errors.push({
        file: read.file,
        property: null,
        message: `has the same name, ${name}, as ${listing(others)}; rename one of them`,
      });
    }
  }
  return unique;
}

/** The Agent `read` describes, or why its effort doesn't fit its provider. */
function defineAgent(
  read: Read<AgentNote>,
  note: AgentNote,
  defaults: Defaults,
  context: SnapshotContext,
): AgentDefinition | string {
  const provider = note.provider ?? defaults.provider;
  const efforts = EFFORTS_BY_PROVIDER[provider];
  if (note.effort !== null && !efforts.includes(note.effort)) {
    return `must be ${listing(efforts)} for ${provider}`;
  }
  const own = defaults.providerDefaults[provider];
  return {
    name: read.identity.name,
    title: read.identity.title,
    file: read.file,
    topics: note.topics,
    provider,
    model: note.model ?? own.model,
    effort: note.effort ?? own.effort,
    permissions: note.permissions ?? defaults.permissions,
    workingDirectory:
      note.workingDirectory === null
        ? context.dataFolder
        : resolvePath(
            note.workingDirectory,
            context.workspace,
            context.homeDir,
          ),
    sharedInstructions: note.sharedInstructions,
    skipGitRepoCheck: note.skipGitRepoCheck,
    enabled: note.enabled,
    instructions: note.instructions,
    note,
  };
}

/** Who answers the topic a title names, by the Agents' `topics`. */
export type TopicClaim =
  | { kind: 'agent'; agent: string }
  /** Several Agents claim it, in `files`: none answers. */
  | { kind: 'conflict'; files: readonly string[] }
  /** Only notes left out for errors, in `files`, claim it. */
  | { kind: 'unloaded'; files: readonly string[] }
  | { kind: 'unclaimed' };

/** Who answers the topic titled `title`, in any case, in `snapshot`. */
export function topicClaim(
  snapshot: Pick<
    SettingsSnapshot,
    'agents' | 'topicClaims' | 'conflictedTopics' | 'unloadedTopics'
  >,
  title: string,
): TopicClaim {
  const key = title.trim().toLowerCase();
  const agent = snapshot.topicClaims.get(key);
  if (agent !== undefined) return { kind: 'agent', agent };
  if (snapshot.conflictedTopics.has(key)) {
    const files = [...snapshot.agents.values()]
      .filter((claiming) =>
        claiming.topics.some((topic) => topic.toLowerCase() === key),
      )
      .map((claiming) => claiming.file)
      .sort(compare);
    return { kind: 'conflict', files };
  }
  const files = snapshot.unloadedTopics.get(key);
  if (files !== undefined) return { kind: 'unloaded', files };
  return { kind: 'unclaimed' };
}

/** Resolves what Workflow notes refer to: Agents and Channels. */
class WorkflowResolver {
  constructor(
    private readonly agents: ReadonlyMap<string, AgentDefinition>,
    private readonly brokenAgents: ReadonlySet<string>,
    private readonly topicClaims: ReadonlyMap<string, string>,
    private readonly conflictedTopics: ReadonlySet<string>,
    private readonly mainAgent: string,
    private readonly topics: TopicLookup | undefined,
  ) {}

  /** The Workflow `read` describes, or the errors that leave it out. */
  define(
    read: Read<WorkflowNote>,
    note: WorkflowNote,
    defaults: Defaults,
  ): WorkflowDefinition | SettingsError[] {
    const errors: SettingsError[] = [];
    const error = (property: string, message: string) =>
      errors.push({ file: read.file, property, message });

    if (note.agent !== null && !this.agents.has(note.agent)) {
      error(
        'agent',
        this.brokenAgents.has(note.agent)
          ? `the Agent note named ${note.agent} has errors`
          : `no Agent note is named ${note.agent}`,
      );
    }
    const channels = note.channels.map((ref) => this.check(ref));
    for (const problem of channels) {
      if (typeof problem === 'string') error('channel', problem);
    }
    const historyChannels = note.history?.channels;
    if (historyChannels !== undefined && historyChannels !== 'all') {
      for (const ref of historyChannels) {
        const problem = this.check(ref);
        if (typeof problem === 'string') error('history-channels', problem);
      }
    }
    if (errors.length > 0) return errors;

    const refs = channels as ResolvedRef[];
    const first = refs[0];
    const answer: Answer =
      note.agent !== null
        ? { kind: 'agent', agent: note.agent }
        : first === undefined
          ? { kind: 'agent', agent: this.mainAgent }
          : this.answering(first);
    if (answer.kind === 'conflict') {
      error(
        'channel',
        `"${String(note.channels[0])}" is claimed by more than one Agent; set agent`,
      );
      return errors;
    }
    const { agent } = answer;
    const ids = (resolved: readonly ResolvedRef[]) =>
      unique(
        resolved.flatMap((ref) =>
          ref.kind === 'channel' ? [ref.channel.id] : [],
        ),
      );

    return {
      name: read.identity.name,
      title: read.identity.title,
      file: read.file,
      agent,
      schedule:
        note.schedule === null
          ? null
          : {
              cron: note.schedule.cron,
              timezone: note.schedule.timezone ?? defaults.timezone,
            },
      channels: note.channels,
      history: note.history,
      resolved:
        this.topics === undefined
          ? null
          : {
              targets: ids(refs),
              history:
                historyChannels === undefined || historyChannels === 'all'
                  ? 'all'
                  : ids(
                      historyChannels.map(
                        (ref) => this.check(ref) as ResolvedRef,
                      ),
                    ),
            },
      maxAttempts: note.maxAttempts,
      enabled: note.enabled,
      input: note.input,
    };
  }

  /** What `ref` names, or why it names nothing. */
  private check(ref: ChannelRef): ResolvedRef | string {
    if (this.topics !== undefined) {
      const found = this.topics.resolve(ref);
      switch (found.kind) {
        case 'ok':
          return { kind: 'channel', channel: found.channel };
        case 'none':
          return typeof ref === 'number'
            ? `no Channel has the ID ${ref}`
            : `no topic titled "${ref}"; seen topics: ${found.seen.join(', ') || 'none yet'}`;
        case 'ambiguous':
          return `"${String(ref)}" matches ${found.matches.length} topics: ${found.matches.join(', ')}; write <chat title>/<topic title>`;
      }
    }
    if (typeof ref === 'number') return { kind: 'id' };
    const slash = ref.indexOf('/');
    if (slash !== -1 && !this.isClaimed(ref)) {
      const chat = ref.slice(0, slash).trim();
      const topic = ref.slice(slash + 1).trim();
      if (chat === '' || topic === '') {
        return `"${ref}" must be a topic title or <chat title>/<topic title>`;
      }
      return { kind: 'title', title: topic };
    }
    return { kind: 'title', title: ref };
  }

  /**
   * The Agent answering in `ref`: the main Agent in a primary Channel or
   * an unclaimed topic, and the claiming one in a claimed topic.
   */
  private answering(ref: ResolvedRef): Answer {
    switch (ref.kind) {
      case 'id':
        return { kind: 'agent', agent: null };
      case 'channel':
        return ref.channel.primary
          ? { kind: 'agent', agent: this.mainAgent }
          : this.claimOf(ref.channel.title);
      case 'title':
        return ref.title.toLowerCase() === GENERAL_TOPIC.toLowerCase()
          ? { kind: 'agent', agent: this.mainAgent }
          : this.claimOf(ref.title);
    }
  }

  private claimOf(title: string): Answer {
    const key = title.toLowerCase();
    return this.conflictedTopics.has(key)
      ? { kind: 'conflict' }
      : { kind: 'agent', agent: this.topicClaims.get(key) ?? this.mainAgent };
  }

  private isClaimed(title: string): boolean {
    const key = title.toLowerCase();
    return this.topicClaims.has(key) || this.conflictedTopics.has(key);
  }
}

/** Who runs a Workflow; a null `agent` is decided once Pero runs. */
type Answer = { kind: 'agent'; agent: string | null } | { kind: 'conflict' };

type ResolvedRef =
  | { kind: 'channel'; channel: ResolvedChannel }
  | { kind: 'title'; title: string }
  | { kind: 'id' };

function unique(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
