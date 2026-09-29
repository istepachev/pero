import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { SHUTDOWN_TIMEOUT_MS } from '../common/shutdown.js';
import type { Provider } from '../config/provider-options.js';
import { DefinitionIds } from '../definitions/definition-ids.js';
import { Definitions, requireAgent } from '../definitions/definitions.js';
import { ComponentHealth } from '../health/component-health.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import type { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { signInHint } from '../providers/provider-auth.js';
import { RuntimeError, type ToolApprover } from '../runtimes/agent-runtime.js';
import { AgentRuntimes } from '../runtimes/agent-runtimes.js';
import { SessionService } from '../sessions/session.service.js';
import { type ResolvedAgent, resolveAgent } from './agent-resolution.js';

/** One message for the Agent assigned to a Channel. */
export interface TurnInput {
  channelId: number;
  agentId: number;
  /** The message as recorded in the Channel's history. */
  messageId: number;
  input: string;
  /** Asks the owner about tools the Agent's permissions leave open. */
  approve?: ToolApprover;
}

/** What the Agent answered, and the Session it answered in. */
export interface TurnResult {
  agentId: number;
  agentName: string;
  sessionId: number;
  text: string;
}

/**
 * A turn outside any Channel, such as a Workflow Run: no Session to resume
 * or record, no history, and no one to approve tools.
 */
export interface IsolatedTurn {
  /** The Agent's settings as captured for this turn. */
  agent: RuntimeAgent;
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

/** The Agent settings a turn runs with. */
export type RuntimeAgent = Omit<ResolvedAgent, 'enabled'>;

/** A turn that produced no answer; the message says why, for the owner. */
export class TurnError extends Error {
  override name = 'TurnError';

  constructor(
    message: string,
    /** True when Pero stopped before or during the turn. */
    readonly interrupted = false,
  ) {
    super(message);
  }
}

const STOPPING = 'Pero is stopping';

/**
 * Runs Agents' turns: builds each request from the Agent record, runs it
 * in the Channel's Session, and persists the provider's session ID as soon
 * as the runtime reports it. A Session whose provider has none of the
 * conversation yet starts from the Channel's latest messages, and each turn
 * receives the Workflow messages posted there since the last person's
 * message. Turns within a Session run one at a time in the order they were
 * accepted; turns of other Sessions run alongside, even in a shared folder.
 * Isolated turns, such as Workflow Runs, use none of a Channel's state.
 */
@Injectable()
export class AgentManager implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Agents');
  /** The last accepted turn of each Session, keyed by Channel and Agent. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Every accepted turn until it settles. */
  private readonly accepted = new Set<Promise<unknown>>();
  /** Aborts each turn that has started. */
  private readonly running = new Set<AbortController>();
  private draining: Promise<void> | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
    private readonly ids: DefinitionIds,
    private readonly sessions: SessionService,
    private readonly runtimes: AgentRuntimes,
    private readonly history: MessageHistory,
    private readonly health: ComponentHealth,
  ) {}

  /**
   * Accepts a turn behind the Session's earlier ones and settles when it
   * has run: with the answer, null when the Agent or Channel was disabled
   * or the Channel reassigned meanwhile, or a `TurnError`.
   */
  runTurn(turn: TurnInput): Promise<TurnResult | null> {
    if (this.draining !== null) {
      return Promise.reject(new TurnError(STOPPING, true));
    }
    // One active Session per Channel and Agent, so this pair names it.
    const key = `${turn.channelId}:${turn.agentId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(() => this.execute(turn));
    const settled = result.catch(() => undefined);
    this.queues.set(key, settled);
    this.accepted.add(settled);
    void settled.then(() => {
      this.accepted.delete(settled);
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return result;
  }

  /**
   * Runs a turn in a new provider conversation of its own, touching no
   * Session or history. Tools the Agent's permissions leave to the owner
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

  private async execute(turn: TurnInput): Promise<TurnResult | null> {
    if (this.draining !== null) throw new TurnError(STOPPING, true);
    const controller = new AbortController();
    this.running.add(controller);
    const startedAt = Date.now();
    const base = `Channel ${turn.channelId}, Agent ${turn.agentId}`;
    let where = base;
    let provider: Provider | null = null;
    try {
      // The Agent as the turn starts, then one snapshot of its Session and
      // the history.
      const resolved = await this.resolve(turn.agentId);
      const first = await inTransaction(this.dataSource, (manager) =>
        this.prepareWithin(manager, turn, resolved, (agent) =>
          this.sessions.beginWithin(manager, turn.channelId, agent),
        ),
      );
      if (first.session === null) {
        this.logger.debug(`Skipped a turn in ${where}: ${first.skipped}`);
        return null;
      }
      const { agent } = first;
      let { session } = first;
      provider = agent.provider;
      where = `${base}, Session ${session.id} (${agent.provider})`;
      // Read first: the turn may record a provider session ID as it runs.
      const resumed = session.providerSessionId;
      let text: string;
      try {
        text = await this.runInSession(first, turn, where, controller);
      } catch (error) {
        if (!lostConversation(error, resumed)) throw error;
        // The provider no longer has the conversation, as after a restore
        // without its own session store: the same turn runs once more in a
        // fresh Session that starts from the Channel's latest messages.
        const retry = await inTransaction(this.dataSource, (manager) =>
          this.prepareWithin(manager, turn, agent, (agent) =>
            this.sessions.replaceWithin(manager, session, agent),
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
        text = await this.runInSession(retry, turn, where, controller);
      }
      this.logger.log(
        `Turn completed in ${where} after ${Date.now() - startedAt} ms`,
      );
      this.signedIn(agent.provider);
      return {
        agentId: agent.id,
        agentName: agent.name,
        sessionId: session.id,
        text,
      };
    } catch (error) {
      throw this.failure(error, provider, where, startedAt, controller);
    } finally {
      this.running.delete(controller);
    }
  }

  /** The Agent with row ID `id`, resolved against the defaults. */
  private async resolve(id: number): Promise<ResolvedAgent> {
    const agent = await requireAgent(
      this.definitions,
      await this.ids.agentName(id),
    );
    return resolveAgent(id, agent, await this.definitions.defaults());
  }

  /**
   * Inside the caller's transaction: why `agent` no longer takes the turn,
   * or the Session `begin` gives it, with the turn's message attached and
   * the input it runs with.
   */
  private async prepareWithin(
    manager: EntityManager,
    turn: TurnInput,
    agent: ResolvedAgent,
    begin: (agent: ResolvedAgent) => Promise<Session>,
  ): Promise<PreparedTurn> {
    const skipped = await skipReasonWithin(manager, turn, agent);
    if (skipped !== null) {
      return { agent, session: null, skipped };
    }
    const session = await begin(agent);
    await this.history.attachSessionWithin(manager, turn.messageId, session.id);
    // Without a provider session, the provider has none of the
    // conversation: a changed provider or folder, a reassigned Channel, a
    // first turn that failed before it began, or a lost conversation.
    const { input, posted, carried } = await this.history.turnInputWithin(
      manager,
      turn.channelId,
      turn.messageId,
      turn.input,
      { carryOver: session.providerSessionId === null },
    );
    return { agent, session, input, posted, carried };
  }

  /** Runs a prepared turn in its Session; resolves to the reply text. */
  private async runInSession(
    { agent, session, input, posted, carried }: ReadyTurn,
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
      agent,
      input,
      {
        ...(session.providerSessionId === null
          ? {}
          : { providerSessionId: session.providerSessionId }),
        ...(turn.approve ? { approve: turn.approve } : {}),
      },
      controller,
      // Committed before this turn settles, so before the next starts.
      (providerSessionId) =>
        this.sessions.recordProviderSessionId(session, providerSessionId),
    );
  }

  private async executeIsolated(turn: IsolatedTurn): Promise<IsolatedResult> {
    const controller = new AbortController();
    this.running.add(controller);
    const cancel = () => controller.abort();
    if (turn.signal?.aborted) cancel();
    turn.signal?.addEventListener('abort', cancel, { once: true });
    const startedAt = Date.now();
    const { agent } = turn;
    const where = `${turn.label}, Agent ${agent.name} (${agent.provider})`;
    try {
      let providerSessionId: string | null = null;
      const text = await this.run(agent, turn.input, {}, controller, (id) => {
        providerSessionId = id;
      });
      this.logger.log(
        `Turn completed in ${where} after ${Date.now() - startedAt} ms`,
      );
      this.signedIn(agent.provider);
      return { text, providerSessionId };
    } catch (error) {
      throw this.failure(error, agent.provider, where, startedAt, controller);
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
    return asTurnError(error, controller.signal.aborted);
  }

  /** A turn succeeded, so a provider reported signed out no longer is. */
  private signedIn(provider: Provider): void {
    if (this.health.get(provider)?.state === 'degraded') {
      this.health.report(provider, 'ok', 'Signed in');
    }
  }

  /**
   * Runs the turn on the Agent's runtime, passing each provider session ID
   * it reports to `onSession`; resolves to the reply text.
   */
  private async run(
    agent: RuntimeAgent,
    input: string,
    options: { providerSessionId?: string; approve?: ToolApprover },
    controller: AbortController,
    onSession: (providerSessionId: string) => unknown,
  ): Promise<string> {
    const runtime = this.runtimes.get(agent.provider);
    if (runtime === null) {
      throw new TurnError(`the ${agent.provider} runtime isn't available yet`);
    }
    let result: string | null = null;
    let streamed = '';
    for await (const event of runtime.execute({
      agentId: agent.id,
      input,
      instructions: agent.instructions,
      providerOptions: agent.providerOptions,
      workingDirectory: agent.workingDirectory,
      skipGitRepoCheck: agent.codexSkipGitRepoCheck,
      ...options,
      toolPolicy: agent.toolPolicy,
      signal: controller.signal,
    })) {
      switch (event.type) {
        case 'session':
          await onSession(event.providerSessionId);
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
  agent: ResolvedAgent;
  session: Session;
  input: string;
  /** How many Workflow messages the input passes on. */
  posted: number;
  /** How many earlier messages the input carries over. */
  carried: number;
}

/** A turn ready to run, or why its Agent no longer takes it. */
type PreparedTurn =
  ReadyTurn | { agent: ResolvedAgent; session: null; skipped: string };

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
 * Why a turn accepted earlier no longer runs: its Agent was disabled, or
 * its Channel was disabled or reassigned meanwhile. Null when it runs.
 */
async function skipReasonWithin(
  manager: EntityManager,
  turn: Pick<TurnInput, 'channelId' | 'agentId'>,
  agent: Pick<ResolvedAgent, 'enabled'>,
): Promise<string | null> {
  if (!agent.enabled) return 'the Agent is disabled';
  const channel = await manager
    .getRepository(Channel)
    .findOneByOrFail({ id: turn.channelId });
  if (!channel.enabled) return 'the Channel is disabled';
  // Otherwise the old Agent would open a Session where it no longer answers.
  if (channel.agentId !== turn.agentId) {
    return 'the Channel was assigned another Agent';
  }
  return null;
}

/** `error` as the owner should read it. */
function asTurnError(error: unknown, aborted: boolean): TurnError {
  if (error instanceof TurnError) return error;
  if (aborted) return new TurnError(STOPPING, true);
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
