import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { SHUTDOWN_TIMEOUT_MS } from '../common/shutdown.js';
import type { Provider } from '../config/provider-options.js';
import { ComponentHealth } from '../health/component-health.js';
import { MessageHistory } from '../history/message-history.service.js';
import type { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { signInHint } from '../providers/provider-auth.js';
import { RuntimeError, type ToolApprover } from '../runtimes/agent-runtime.js';
import { AgentRuntimes } from '../runtimes/agent-runtimes.js';
import { SessionService } from '../sessions/session.service.js';
import { AgentsService, type ResolvedAgent } from './agents.service.js';

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
 * conversation yet starts from the Channel's latest messages. Turns within a Session run one at a time in
 * the order they were accepted; turns of other Sessions run alongside,
 * even in a shared folder.
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
    private readonly agents: AgentsService,
    private readonly sessions: SessionService,
    private readonly runtimes: AgentRuntimes,
    private readonly history: MessageHistory,
    private readonly health: ComponentHealth,
  ) {}

  /**
   * Accepts a turn behind the Session's earlier ones and settles when it
   * has run: with the answer, null when the Agent was disabled meanwhile,
   * or a `TurnError`.
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
    let where = `Channel ${turn.channelId}, Agent ${turn.agentId}`;
    let provider: Provider | null = null;
    try {
      // One snapshot of the Agent, settings, Session, and history as the
      // turn starts.
      const { agent, session, input, carried } = await inTransaction(
        this.dataSource,
        async (manager) => {
          const agent = await this.agents.resolveWithin(manager, turn.agentId);
          if (!agent.enabled) {
            return { agent, session: null, input: turn.input, carried: 0 };
          }
          const session = await this.sessions.beginWithin(
            manager,
            turn.channelId,
            agent,
          );
          await this.history.attachSessionWithin(
            manager,
            turn.messageId,
            session.id,
          );
          // Without a provider session, the provider has none of the
          // conversation: a changed provider or folder, a reassigned
          // Channel, or a first turn that failed before it began.
          const { input, carried } =
            session.providerSessionId === null
              ? await this.history.carryOverWithin(
                  manager,
                  turn.channelId,
                  turn.messageId,
                  turn.input,
                )
              : { input: turn.input, carried: 0 };
          return { agent, session, input, carried };
        },
      );
      if (session === null) {
        this.logger.debug(`Skipped a turn in ${where}: the Agent is disabled`);
        return null;
      }
      provider = agent.provider;
      where += `, Session ${session.id} (${agent.provider})`;
      if (carried > 0) {
        this.logger.log(`Carried over ${carried} message(s) into ${where}`);
      }
      const text = await this.run(
        agent,
        session,
        input,
        turn.approve,
        controller,
      );
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
      const failure = asTurnError(error, controller.signal.aborted);
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
      throw failure;
    } finally {
      this.running.delete(controller);
    }
  }

  /** A turn succeeded, so a provider reported signed out no longer is. */
  private signedIn(provider: Provider): void {
    if (this.health.get(provider)?.state === 'degraded') {
      this.health.report(provider, 'ok', 'Signed in');
    }
  }

  /** Runs the turn on the Agent's runtime; resolves to the reply text. */
  private async run(
    agent: ResolvedAgent,
    session: Session,
    input: string,
    approve: ToolApprover | undefined,
    controller: AbortController,
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
      ...(session.providerSessionId === null
        ? {}
        : { providerSessionId: session.providerSessionId }),
      toolPolicy: agent.toolPolicy,
      ...(approve ? { approve } : {}),
      signal: controller.signal,
    })) {
      switch (event.type) {
        case 'session':
          // Committed before this turn settles, so before the next starts.
          await this.sessions.recordProviderSessionId(
            session,
            event.providerSessionId,
          );
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
      case 'failed':
        return new TurnError(error.message);
    }
  }
  return new TurnError('Pero failed to run the turn; see pero logs');
}
