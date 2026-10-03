import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { SHUTDOWN_TIMEOUT_MS } from '../common/shutdown.js';
import type { Provider } from '../config/provider-options.js';
import { workspaceLayout } from '../config/workspace-layout.js';
import { guideFile } from '../guide/agent-guide.js';
import { ComponentHealth } from '../health/component-health.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import type { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { signInHint } from '../providers/provider-auth.js';
import {
  RuntimeError,
  type RuntimeRequest,
  type ToolApprover,
} from '../runtimes/agent-runtime.js';
import { AgentRuntimes } from '../runtimes/agent-runtimes.js';
import {
  type ContextUsage,
  SessionService,
} from '../sessions/session.service.js';
import type { ChannelNote } from '../system-files/snapshot.js';
import { Definitions, routeQuery } from '../system/definitions.js';
import { SystemNotes } from '../system/system-notes.service.js';
import { SpeechService } from '../speech/speech.service.js';
import {
  type AgentRequest,
  agentRequest,
  type InstructionDefaults,
} from './agent-request.js';

/** One message in a Channel, for Pero to answer. */
export interface TurnInput {
  channelId: number;
  /** The message as recorded in the Channel's history. */
  messageId: number;
  input: string;
  /** Where the files the message came with are saved; none when absent. */
  attachments?: readonly string[];
  /** Asks the owner about tools the note's permissions leave open. */
  approve?: ToolApprover;
}

/** What Pero answered, and the Session it answered in. */
export interface TurnResult {
  /** The name of the Channel note the turn ran with. */
  agentName: string;
  sessionId: number;
  text: string;
}

/**
 * A turn outside any Channel, such as a Workflow Run: no Session to resume
 * or record, no history, and no one to approve tools.
 */
export interface IsolatedTurn {
  /** The name of the Channel note it runs with. */
  note: string;
  provider: Provider;
  /** The note's part of the request, as captured for this turn. */
  request: AgentRequest;
  input: string;
  /** Names the turn in logs, such as `Workflow daily-brief, run 7`. */
  label: string;
  /** Cancels the turn, such as when the owner cancels its run. */
  signal?: AbortSignal;
}

/** What an isolated turn answered. */
export interface IsolatedResult {
  text: string;
  /** The provider's ID for the conversation; null if it reported none. */
  providerSessionId: string | null;
}

/** A turn that produced no answer; the message says why, for the owner. */
export class TurnError extends Error {
  override name = 'TurnError';

  constructor(
    message: string,
    /** True when Pero stopped before or during the turn. */
    readonly interrupted = false,
    /** True when someone stopped the Channel's turns, as with `/stop`. */
    readonly stopped = false,
  ) {
    super(message);
  }
}

/** What Pero is doing in a Channel, for `/status`. */
export interface ChannelActivity {
  /** When the running turn started; null when none is running. */
  runningSince: Date | null;
  /** How many accepted turns wait behind it. */
  queued: number;
}

/** What `stop` ended. */
export interface StopResult {
  /** Whether a turn was running. */
  stopped: boolean;
  /** How many waiting turns will never start. */
  dropped: number;
}

const STOPPING = 'Pero is stopping';

/** The abort reason of a turn someone stopped. */
const STOPPED = Symbol('stopped');

/** A Channel's turns that have not settled yet. */
interface ChannelTurnsState {
  running: Set<{ controller: AbortController; startedAt: Date }>;
  queued: number;
  /** Counts stops; a turn accepted before the latest one never starts. */
  stops: number;
}

/**
 * Runs turns: builds each request from the note the Channel uses as the
 * turn starts, runs it in the Channel's Session, and persists the
 * provider's session ID as soon as the runtime reports it. A Session whose provider has none of the
 * conversation yet starts from the Channel's latest messages, and each turn
 * receives the Workflow messages posted there since the last person's
 * message. Turns within a Session run one at a time in the order they were
 * accepted; turns of other Sessions run alongside, even in a shared folder.
 * Isolated turns, such as Workflow Runs, use none of a Channel's state.
 */
@Injectable()
export class AgentManager implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Agents');
  /** The last accepted turn of each Channel's Session, by Channel. */
  private readonly queues = new Map<number, Promise<unknown>>();
  /** Every accepted turn until it settles. */
  private readonly accepted = new Set<Promise<unknown>>();
  /** Aborts each turn that has started. */
  private readonly running = new Set<AbortController>();
  /** Each Channel's turns until they settle, so they can be stopped. */
  private readonly channels = new Map<number, ChannelTurnsState>();
  private draining: Promise<void> | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
    private readonly sessions: SessionService,
    private readonly runtimes: AgentRuntimes,
    private readonly history: MessageHistory,
    private readonly health: ComponentHealth,
    private readonly notes: SystemNotes,
    private readonly speech: SpeechService,
  ) {}

  /**
   * What turns' and runs' instructions are composed with: the defaults,
   * and whether Pero can record voice messages now.
   */
  instructionDefaults(): InstructionDefaults {
    return { ...this.definitions.defaults(), voice: this.speech.canSpeak() };
  }

  /**
   * Accepts a turn behind the Session's earlier ones and settles when it
   * has run: with the answer, null when Pero no longer answers in the
   * Channel, or a `TurnError`.
   */
  runTurn(turn: TurnInput): Promise<TurnResult | null> {
    if (this.draining !== null) {
      return Promise.reject(new TurnError(STOPPING, true));
    }
    // One active Session per Channel.
    const key = turn.channelId;
    const channel = this.channelTurns(turn.channelId);
    const stops = channel.stops;
    channel.queued++;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(() => {
      channel.queued--;
      if (channel.stops !== stops) {
        throw new TurnError('the turn was stopped', false, true);
      }
      return this.execute(turn, channel);
    });
    const settled = result.catch(() => undefined);
    this.queues.set(key, settled);
    this.accepted.add(settled);
    void settled.then(() => {
      this.accepted.delete(settled);
      if (this.queues.get(key) === settled) this.queues.delete(key);
      if (channel.queued === 0 && channel.running.size === 0) {
        this.channels.delete(turn.channelId);
      }
    });
    return result;
  }

  /**
   * Stops Channel `channelId`'s running turn, which ends with a stopped
   * `TurnError`, and drops the turns waiting behind it.
   */
  stop(channelId: number): StopResult {
    const channel = this.channels.get(channelId);
    if (channel === undefined) return { stopped: false, dropped: 0 };
    channel.stops++;
    for (const { controller } of channel.running) controller.abort(STOPPED);
    return { stopped: channel.running.size > 0, dropped: channel.queued };
  }

  /** What Channel `channelId`'s Agent is doing now. */
  activity(channelId: number): ChannelActivity {
    const channel = this.channels.get(channelId);
    const starts = [...(channel?.running ?? [])].map((run) => run.startedAt);
    return {
      runningSince:
        starts.length === 0
          ? null
          : new Date(Math.min(...starts.map((start) => start.getTime()))),
      queued: channel?.queued ?? 0,
    };
  }

  private channelTurns(channelId: number): ChannelTurnsState {
    let channel = this.channels.get(channelId);
    if (channel === undefined) {
      channel = { running: new Set(), queued: 0, stops: 0 };
      this.channels.set(channelId, channel);
    }
    return channel;
  }

  /**
   * Runs a turn in a new provider conversation of its own, touching no
   * Session or history. Tools the note's permissions leave to the owner
   * are refused, since no one is there to ask. Settles with the answer or a
   * `TurnError`; the caller bounds how many run at once.
   */
  runIsolated(turn: IsolatedTurn): Promise<IsolatedResult> {
    if (this.draining !== null) {
      return Promise.reject(new TurnError(STOPPING, true));
    }
    const result = this.executeIsolated(turn);
    const settled = result.catch(() => undefined);
    this.accepted.add(settled);
    void settled.then(() => this.accepted.delete(settled));
    return result;
  }

  /**
   * Stops accepting turns and lets running ones finish for up to
   * `timeoutMs`, then aborts them. Turns still queued never start. Later
   * calls share the first one's result.
   */
  drain(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.draining ??= this.settle(timeoutMs);
    return this.draining;
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.drain();
  }

  private async settle(timeoutMs: number): Promise<void> {
    const all = Promise.all(this.accepted);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    try {
      if (await Promise.race([all.then(() => false), expired])) {
        this.logger.warn(
          `Aborting ${this.running.size} turn(s) still running after ` +
            `${timeoutMs} ms`,
        );
        for (const controller of this.running) controller.abort();
        await all;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(
    turn: TurnInput,
    channel: ChannelTurnsState,
  ): Promise<TurnResult | null> {
    if (this.draining !== null) throw new TurnError(STOPPING, true);
    const controller = new AbortController();
    this.running.add(controller);
    const run = { controller, startedAt: new Date() };
    channel.running.add(run);
    const startedAt = run.startedAt.getTime();
    let base = `Channel ${turn.channelId}`;
    let where = base;
    let provider: Provider | null = null;
    try {
      // The note as the turn starts, then one snapshot of its Session and
      // the history.
      const first = await inTransaction(this.dataSource, (manager) =>
        this.prepareWithin(manager, turn, (note) =>
          this.sessions.beginWithin(manager, turn.channelId, note),
        ),
      );
      if (first.session === null) {
        this.logger.debug(`Skipped a turn in ${where}: ${first.skipped}`);
        return null;
      }
      const { note: agent } = first;
      const request = agentRequest(agent, this.instructionDefaults());
      let { session } = first;
      provider = agent.provider;
      base = `Channel ${turn.channelId}, note ${agent.name}`;
      where = `${base}, Session ${session.id} (${agent.provider})`;
      // Read first: the turn may record a provider session ID as it runs.
      const resumed = session.providerSessionId;
      let text: string;
      try {
        text = await this.runInSession(first, request, turn, where, controller);
      } catch (error) {
        if (!lostConversation(error, resumed)) throw error;
        // The provider no longer has the conversation, as after a restore
        // without its own session store: the same turn runs once more in a
        // fresh Session that starts from the Channel's latest messages.
        const retry = await inTransaction(this.dataSource, (manager) =>
          this.prepareWithin(manager, turn, (note) =>
            this.sessions.replaceWithin(manager, session, note),
          ),
        );
        this.logger.warn(
          `The ${agent.provider} conversation ${resumed} of ${where} is gone; ` +
            (retry.session === null
              ? `skipped the turn: ${retry.skipped}`
              : `continuing in Session ${retry.session.id}`),
        );
        if (retry.session === null) return null;
        session = retry.session;
        where = `${base}, Session ${session.id} (${agent.provider})`;
        text = await this.runInSession(
          retry,
          agentRequest(retry.note, this.instructionDefaults()),
          turn,
          where,
          controller,
        );
      }
      this.logger.log(
        `Turn completed in ${where} after ${Date.now() - startedAt} ms`,
      );
      this.signedIn(agent.provider);
      return {
        agentName: agent.name,
        sessionId: session.id,
        text,
      };
    } catch (error) {
      throw this.failure(error, provider, where, startedAt, controller);
    } finally {
      this.running.delete(controller);
      channel.running.delete(run);
    }
  }

  /**
   * Inside the caller's transaction: why Pero no longer answers the turn,
   * or the note the Channel uses now and the Session `begin` gives it,
   * with the turn's message attached and the input it runs with.
   */
  private async prepareWithin(
    manager: EntityManager,
    turn: TurnInput,
    begin: (note: ChannelNote) => Promise<Session>,
  ): Promise<PreparedTurn> {
    const note = await routeWithin(manager, this.definitions, turn);
    if (typeof note === 'string') {
      return { session: null, skipped: note };
    }
    const session = await begin(note);
    await this.history.attachSessionWithin(manager, turn.messageId, session.id);
    // Without a provider session, the provider has none of the
    // conversation: a changed provider or folder, a changed route, a
    // first turn that failed before it began, or a lost conversation.
    const { input, posted, carried } = await this.history.turnInputWithin(
      manager,
      turn.channelId,
      turn.messageId,
      turn.input,
      { carryOver: session.providerSessionId === null },
    );
    return { note, session, input, posted, carried };
  }

  /**
   * Runs a prepared turn in its Session with `request`, the note's part of
   * it; resolves to the reply text.
   */
  private async runInSession(
    { note, session, input, posted, carried }: ReadyTurn,
    request: AgentRequest,
    turn: TurnInput,
    where: string,
    controller: AbortController,
  ): Promise<string> {
    if (carried > 0) {
      this.logger.log(`Carried over ${carried} message(s) into ${where}`);
    }
    if (posted > 0) {
      this.logger.log(`Passed ${posted} Workflow message(s) into ${where}`);
    }
    return this.run(
      note.provider,
      { ...request, input },
      {
        ...(session.providerSessionId === null
          ? {}
          : { providerSessionId: session.providerSessionId }),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
        ...(turn.approve ? { approve: turn.approve } : {}),
      },
      controller,
      {
        // Committed before this turn settles, so before the next starts.
        session: (providerSessionId) =>
          this.sessions.recordProviderSessionId(session, providerSessionId),
        usage: (usage) => this.sessions.recordContext(session, usage),
      },
    );
  }

  private async executeIsolated(turn: IsolatedTurn): Promise<IsolatedResult> {
    const controller = new AbortController();
    this.running.add(controller);
    const cancel = () => controller.abort();
    if (turn.signal?.aborted) cancel();
    turn.signal?.addEventListener('abort', cancel, { once: true });
    const startedAt = Date.now();
    const { provider } = turn;
    const where = `${turn.label}, note ${turn.note} (${provider})`;
    try {
      let providerSessionId: string | null = null;
      const text = await this.run(
        provider,
        { ...turn.request, input: turn.input },
        // Nothing resumes it, so the provider needn't keep it.
        { ephemeral: true },
        controller,
        {
          session: (id) => {
            providerSessionId = id;
          },
        },
      );
      this.logger.log(
        `Turn completed in ${where} after ${Date.now() - startedAt} ms`,
      );
      this.signedIn(provider);
      return { text, providerSessionId };
    } catch (error) {
      throw this.failure(error, provider, where, startedAt, controller);
    } finally {
      turn.signal?.removeEventListener('abort', cancel);
      this.running.delete(controller);
    }
  }

  /** Logs a failed turn and says why it failed, for the owner. */
  private failure(
    error: unknown,
    provider: Provider | null,
    where: string,
    startedAt: number,
    controller: AbortController,
  ): TurnError {
    if (
      provider !== null &&
      error instanceof RuntimeError &&
      error.kind === 'auth'
    ) {
      this.health.report(
        provider,
        'degraded',
        `A turn was refused as signed out — run ${signInHint(provider)}`,
      );
    }
    this.logger.warn(
      `Turn failed in ${where} after ${Date.now() - startedAt} ms: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return asTurnError(error, controller.signal);
  }

  /** A turn succeeded, so a provider reported signed out no longer is. */
  private signedIn(provider: Provider): void {
    if (this.health.get(provider)?.state === 'degraded') {
      this.health.report(provider, 'ok', 'Signed in');
    }
  }

  /**
   * Runs the turn on `provider`'s runtime, passing each provider session ID
   * and context usage it reports to `on`; resolves to the reply text.
   */
  private async run(
    provider: Provider,
    request: AgentRequest & { input: string },
    options: Pick<
      RuntimeRequest,
      'providerSessionId' | 'attachments' | 'approve' | 'ephemeral'
    >,
    controller: AbortController,
    on: {
      session: (providerSessionId: string) => unknown;
      usage?: (usage: ContextUsage) => unknown;
    },
  ): Promise<string> {
    const runtime = this.runtimes.get(provider);
    if (runtime === null) {
      throw new TurnError(`the ${provider} runtime isn't available yet`);
    }
    const folders = this.notes.folders();
    let result: string | null = null;
    let streamed = '';
    for await (const event of runtime.execute({
      ...request,
      ...options,
      // So that a turn can't change Pero's configuration unasked.
      systemFolder: folders.systemFolder,
      guideFile: guideFile(folders.workspace),
      attachmentsFolder: workspaceLayout(folders.workspace).attachments,
      signal: controller.signal,
    })) {
      switch (event.type) {
        case 'session':
          await on.session(event.providerSessionId);
          break;
        case 'usage':
          await on.usage?.({
            tokens: event.contextTokens,
            window: event.contextWindow,
          });
          break;
        case 'text':
          streamed += event.delta;
          break;
        case 'result':
          result = event.text;
          break;
        case 'tool':
          break;
      }
    }
    return (result ?? streamed).trim();
  }
}

/** A turn ready to run in its Session. */
interface ReadyTurn {
  /** The note the Channel uses as the turn starts. */
  note: ChannelNote;
  session: Session;
  input: string;
  /** How many Workflow messages the input passes on. */
  posted: number;
  /** How many earlier messages the input carries over. */
  carried: number;
}

/** A turn ready to run, or why Pero no longer answers it. */
type PreparedTurn = ReadyTurn | { session: null; skipped: string };

/**
 * Whether `error` says the provider no longer has the conversation
 * `resumed`, the provider session a turn resumed. A turn that resumed
 * nothing never counts, so the fresh Session replacing it runs only once.
 */
function lostConversation(error: unknown, resumed: string | null): boolean {
  return (
    resumed !== null &&
    error instanceof RuntimeError &&
    error.kind === 'session_lost'
  );
}

/**
 * The note Channel `turn.channelId` uses now, or why a turn accepted
 * earlier no longer runs: Pero no longer answers there, as when its note
 * was disabled meanwhile.
 */
async function routeWithin(
  manager: EntityManager,
  definitions: Definitions,
  turn: Pick<TurnInput, 'channelId'>,
): Promise<ChannelNote | string> {
  const channel = await manager
    .getRepository(Channel)
    .findOneByOrFail({ id: turn.channelId });
  const route = definitions.route(routeQuery(channel));
  if (route.kind === 'unanswered') {
    return 'Pero no longer answers in the Channel';
  }
  return route.note;
}

/** `error` as the owner should read it; `signal` is the turn's own. */
function asTurnError(error: unknown, signal: AbortSignal): TurnError {
  if (error instanceof TurnError) return error;
  if (signal.aborted && signal.reason === STOPPED) {
    return new TurnError('the turn was stopped', false, true);
  }
  if (signal.aborted) return new TurnError(STOPPING, true);
  if (error instanceof RuntimeError) {
    switch (error.kind) {
      case 'auth':
        return new TurnError(
          `the provider is signed out (${error.message}); ` +
            `run pero status on the Pero host`,
        );
      case 'cancelled':
        return new TurnError('the turn was cancelled');
      case 'session_lost':
      case 'failed':
        return new TurnError(error.message);
    }
  }
  return new TurnError('Pero failed to run the turn; see pero logs');
}
