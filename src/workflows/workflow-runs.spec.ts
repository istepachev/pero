import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentManager, TurnError } from '../agents/agent-manager.js';
import { AgentsService } from '../agents/agents.service.js';
import { AgentChannelTurns } from '../channels/agent-channel-turns.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { ChannelTurns } from '../channels/channel-stages.js';
import { ChannelsModule } from '../channels/channels.module.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  privateChat,
} from '../channels/testing/fake-channel-adapter.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import type { WorkflowHistoryPatch } from '../config/workflow-input.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import type { RunView } from '../control/protocol.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import type { RuntimeRequest } from '../runtimes/agent-runtime.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';
import type { HistoryRead } from './execution-snapshot.js';
import { CANCELLED, WorkflowExecutor } from './workflow-executor.js';
import { WorkflowRuns } from './workflow-runs.service.js';
import { WorkflowsModule } from './workflows.module.js';
import { WorkflowsService } from './workflows.service.js';

const OWNER = privateChat('1234');
const HOME = groupChat('-100777', 'Home');

describe('Workflow Runs and the executor', () => {
  let tmp: string;
  let vault: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let agents: AgentsService;
  let settings: SettingsService;
  let workflows: WorkflowsService;
  let triggers: TriggersService;
  let runs: WorkflowRuns;
  let executor: WorkflowExecutor;
  let claude: FakeAgentRuntime;
  let codex: FakeAgentRuntime;

  async function boot() {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        ChannelsModule,
        WorkflowsModule,
        TriggersModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([claude, codex])
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    agents = moduleRef.get(AgentsService);
    settings = moduleRef.get(SettingsService);
    workflows = moduleRef.get(WorkflowsService);
    triggers = moduleRef.get(TriggersService);
    runs = moduleRef.get(WorkflowRuns);
    executor = moduleRef.get(WorkflowExecutor);
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-workflow-runs-'));
    vault = join(tmp, 'vault');
    mkdirSync(vault);
    claude = new FakeAgentRuntime('claude');
    codex = new FakeAgentRuntime('codex');
    await boot();
    await settings.update({
      defaultProvider: 'claude',
      defaultWorkingDirectory: vault,
    });
    await agents.create({ name: 'coach' });
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A Workflow of `agent` that can be run by hand. */
  async function manualWorkflow(
    name: string,
    input = `Run ${name}.`,
    agent = 'coach',
  ): Promise<void> {
    await workflows.create({ name, agent, inputTemplate: input });
    await triggers.add({ workflow: name, kind: 'manual' });
  }

  function run(id: number): Promise<RunView> {
    return runs.get(id);
  }

  /** Lets queued promise callbacks and database work run. */
  function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("completes a run with the Agent's answer, in a provider session of its own", async () => {
    await manualWorkflow('brief', 'Summarize the day.');

    const queued = await runs.start('brief');
    expect(queued).toMatchObject({
      workflow: 'brief',
      status: 'pending',
      attempt: 1,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });
    expect(queued.triggerKey).toMatch(/^manual:[0-9a-f-]{36}$/);
    await executor.idle();

    const done = await run(queued.id);
    expect(done).toMatchObject({
      status: 'completed',
      result: 'echo: Summarize the day.',
      error: null,
    });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    const coach = await agents.get('coach');
    expect(claude.requests).toHaveLength(1);
    expect(claude.requests[0]).toMatchObject({
      agentId: coach.id,
      input: 'Summarize the day.',
      workingDirectory: vault,
      toolPolicy: { permissions: 'ask' },
    });
    expect(claude.requests[0]).not.toHaveProperty('providerSessionId');
    expect(claude.requests[0]).not.toHaveProperty('approve');
    const row = await ds
      .getRepository(WorkflowRun)
      .findOneByOrFail({ id: queued.id });
    expect(row.executionConfig).toMatchObject({
      agentId: coach.id,
      agentName: 'coach',
      provider: 'claude',
      workingDirectory: vault,
      input: 'Summarize the day.',
    });
    expect(row.result).toEqual({
      text: 'echo: Summarize the day.',
      providerSessionId: 'fake-claude-1',
    });
  });

  it('records a failed run with the reason', async () => {
    await manualWorkflow('brief');
    claude.failNext();

    const { id } = await runs.start('brief');
    await executor.idle();

    expect(await run(id)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'The model is overloaded',
    });
  });

  describe('concurrency', () => {
    it('runs no more than max-concurrent-runs at once', async () => {
      await settings.update({ maxConcurrentRuns: 2 });
      for (const name of ['a', 'b', 'c']) await manualWorkflow(name);
      const held = [claude.hold(), claude.hold(), claude.hold()];

      const a = await runs.start('a');
      const b = await runs.start('b');
      const c = await runs.start('c');
      await held[0]!.started;
      await held[1]!.started;
      await tick();

      expect(executor.running).toBe(2);
      expect(claude.requests).toHaveLength(2);
      expect((await run(c.id)).status).toBe('pending');

      held[0]!.release();
      expect((await held[2]!.started).input).toBe('Run c.');
      expect((await run(a.id)).status).toBe('completed');
      expect((await run(c.id)).status).toBe('running');

      held[1]!.release();
      held[2]!.release();
      await executor.idle();
      for (const { id } of [a, b, c]) {
        expect((await run(id)).status).toBe('completed');
      }
    });

    it('applies a raised limit on the next wake, without a restart', async () => {
      await settings.update({ maxConcurrentRuns: 1 });
      await manualWorkflow('a');
      await manualWorkflow('b');
      const held = [claude.hold(), claude.hold()];

      await runs.start('a');
      const b = await runs.start('b');
      await held[0]!.started;
      await tick();
      expect((await run(b.id)).status).toBe('pending');

      await settings.update({ maxConcurrentRuns: 2 });
      await executor.wake();

      expect((await held[1]!.started).input).toBe('Run b.');
      expect(executor.running).toBe(2);
      held[0]!.release();
      held[1]!.release();
      await executor.idle();
    });

    it('runs one run of a Workflow at a time, and other Workflows alongside', async () => {
      await settings.update({ maxConcurrentRuns: 3 });
      await manualWorkflow('a');
      await manualWorkflow('b');
      const held = [claude.hold(), claude.hold()];

      const first = await runs.start('a');
      const second = await runs.start('a');
      const other = await runs.start('b');
      await held[0]!.started;
      expect((await held[1]!.started).input).toBe('Run b.');
      await tick();

      expect(executor.running).toBe(2);
      expect((await run(second.id)).status).toBe('pending');

      held[0]!.release();
      held[1]!.release();
      await executor.idle();

      const [a1, a2, b1] = await Promise.all(
        [first, second, other].map(({ id }) => run(id)),
      );
      expect([a1!.status, a2!.status, b1!.status]).toEqual([
        'completed',
        'completed',
        'completed',
      ]);
      expect(Date.parse(a2!.startedAt!)).toBeGreaterThanOrEqual(
        Date.parse(a1!.finishedAt!),
      );
    });
  });

  it('runs with the settings captured when it started, whatever is edited meanwhile', async () => {
    await settings.update({ sharedInstructions: 'Be kind.' });
    await manualWorkflow('brief', 'First input.');
    const held = claude.hold();

    const { id } = await runs.start('brief');
    const request = await held.started;
    const own = join(tmp, 'own');
    mkdirSync(own);
    await agents.edit('coach', {
      provider: 'codex',
      providerOptions: { model: 'gpt-6', effort: 'high' },
      instructions: 'Be brief.',
      workingDirectory: own,
    });
    await workflows.edit('brief', { inputTemplate: 'Second input.' });
    held.release();
    await executor.idle();

    const captured = {
      input: 'First input.',
      instructions: 'Be kind.',
      providerOptions: { model: null, effort: null },
      workingDirectory: vault,
    };
    expect(request).toMatchObject(captured);
    expect((await run(id)).result).toBe('echo: First input.');
    const row = await ds.getRepository(WorkflowRun).findOneByOrFail({ id });
    expect(row.executionConfig).toMatchObject({
      ...captured,
      provider: 'claude',
    });

    // A run started later takes the new settings.
    await runs.start('brief');
    await executor.idle();
    expect(codex.requests).toHaveLength(1);
    expect(codex.requests[0]).toMatchObject({
      input: 'Second input.',
      instructions: 'Be kind.\n\nBe brief.',
      providerOptions: { model: 'gpt-6', effort: 'high' },
      workingDirectory: own,
    });
  });

  it("never touches a Channel's Session or history", async () => {
    await moduleRef.get(AllowedChatsService).allow({
      integrationKind: 'telegram',
      chatKey: OWNER.key,
      kind: OWNER.kind,
      title: OWNER.title,
    });
    const adapter = new FakeChannelAdapter();
    await moduleRef.get(ChannelRouter).connect(adapter);
    const channelTurns = moduleRef.get(ChannelTurns) as AgentChannelTurns;
    const say = async (text: string) => {
      await adapter.deliver(inboundMessage(OWNER, { text }));
      await channelTurns.idle();
    };
    await say('Hello');
    const sessionsBefore = await ds.getRepository(Session).find();
    const messagesBefore = await ds.getRepository(Message).count();
    await manualWorkflow('review', 'Review the chat.', 'main');
    claude.askNext();

    const { id } = await runs.start('review');
    await executor.idle();

    const runRequest = claude.requests[1] as RuntimeRequest;
    expect(runRequest.agentId).toBe(sessionsBefore[0]!.agentId);
    expect(runRequest).not.toHaveProperty('providerSessionId');
    expect(runRequest).not.toHaveProperty('approve');
    // No one is there to approve tools, so they are refused.
    expect((await run(id)).result).toBe(
      'echo: Review the chat. (Bash denied: no one can approve tools here)',
    );
    expect(await ds.getRepository(Session).find()).toEqual(sessionsBefore);
    expect(await ds.getRepository(Message).count()).toBe(messagesBefore);

    // The Channel's next turn resumes its own provider session.
    await say('Again');
    expect(claude.requests[2]).toMatchObject({
      input: 'Again',
      providerSessionId: sessionsBefore[0]!.providerSessionId,
    });
  });

  describe('recovery', () => {
    /**
     * Starts a run of `workflow` and stops Pero while its Agent works, as
     * `pero stop` does once the shutdown timeout has passed. Returns the
     * run's ID and the aborted request.
     */
    async function stopMidRun(
      workflow: string,
    ): Promise<{ id: number; request: RuntimeRequest }> {
      const held = claude.hold();
      const { id } = await runs.start(workflow);
      const request = await held.started;
      await moduleRef.get(AgentManager).drain(10);
      await executor.idle();
      return { id, request };
    }

    async function restart(): Promise<void> {
      await moduleRef.close();
      await boot();
      await executor.idle();
    }

    function allRuns(): Promise<WorkflowRun[]> {
      return ds.getRepository(WorkflowRun).find({ order: { id: 'ASC' } });
    }

    it('leaves a run Pero stopped for the next start, which records it interrupted', async () => {
      await manualWorkflow('brief');
      const { id, request } = await stopMidRun('brief');

      expect(request.signal.aborted).toBe(true);
      // Nothing is recorded while Pero stops.
      expect(await run(id)).toMatchObject({
        status: 'running',
        finishedAt: null,
        error: null,
      });
      await expect(
        moduleRef.get(AgentManager).runIsolated({
          agent: {
            id: 1,
            name: 'coach',
            provider: 'claude',
            providerOptions: { model: null, effort: null },
            workingDirectory: vault,
            instructions: '',
            toolPolicy: { permissions: 'ask' },
            codexSkipGitRepoCheck: false,
          },
          input: 'Late',
          label: 'test',
        }),
      ).rejects.toThrow(TurnError);

      await restart();

      const interrupted = await run(id);
      expect(interrupted).toMatchObject({
        status: 'interrupted',
        error:
          'Pero stopped before the run finished; not retried: Workflow brief allows 1 attempt',
      });
      expect(interrupted.finishedAt).not.toBeNull();
      expect(await allRuns()).toHaveLength(1);
      expect(claude.requests).toHaveLength(1);
    });

    it('records a run left running by a crash interrupted', async () => {
      await manualWorkflow('brief');
      const workflow = await workflows.get('brief');
      const repo = ds.getRepository(WorkflowRun);
      const { id } = await repo.save(
        repo.create({
          workflowId: workflow.id,
          triggerId: null,
          triggerKey: 'manual:crashed',
          status: 'running',
          attempt: 1,
          startedAt: new Date(),
        }),
      );

      await restart();

      expect(await run(id)).toMatchObject({
        status: 'interrupted',
        error:
          'Pero stopped before the run finished; not retried: Workflow brief allows 1 attempt',
      });
      expect(claude.requests).toHaveLength(0);
    });

    it('retries an interrupted run as a new run while the Workflow allows more attempts', async () => {
      await manualWorkflow('brief');
      await workflows.edit('brief', { maxAttempts: 2 });
      const { id } = await stopMidRun('brief');
      const { triggerId } = await run(id);

      await restart();

      const [original, retry] = await allRuns();
      expect(retry).toMatchObject({
        workflowId: original!.workflowId,
        triggerId,
        triggerKey: `retry:${id}`,
        attempt: 2,
        status: 'completed',
      });
      expect(await run(id)).toMatchObject({
        status: 'interrupted',
        attempt: 1,
        error: `Pero stopped before the run finished; run ${retry!.id} retries it (attempt 2 of 2)`,
      });
      expect(claude.requests.map((request) => request.input)).toEqual([
        'Run brief.',
        'Run brief.',
      ]);
    });

    it('stops retrying once a run has had its attempts', async () => {
      await manualWorkflow('brief');
      await workflows.edit('brief', { maxAttempts: 2 });
      const { id } = await stopMidRun('brief');
      // The retry is stopped as well.
      const held = claude.hold();
      await moduleRef.close();
      await boot();
      await held.started;
      await moduleRef.get(AgentManager).drain(10);
      await executor.idle();

      await restart();

      const [, retry, ...more] = await allRuns();
      expect(more).toEqual([]);
      expect(await run(retry!.id)).toMatchObject({
        status: 'interrupted',
        attempt: 2,
        error:
          'Pero stopped before the run finished; not retried: Workflow brief allows 2 attempts',
      });
      expect((await run(id)).status).toBe('interrupted');
    });

    it('does not retry while the Workflow or its Agent is disabled', async () => {
      await manualWorkflow('a');
      await manualWorkflow('b');
      await workflows.edit('a', { maxAttempts: 3 });
      await workflows.edit('b', { maxAttempts: 3 });
      const a = await stopMidRun('a');
      await workflows.edit('a', { enabled: false });
      await restart();
      const b = await stopMidRun('b');
      await agents.edit('coach', { enabled: false });

      await restart();

      expect((await run(a.id)).error).toBe(
        'Pero stopped before the run finished; not retried: Workflow a is disabled',
      );
      expect((await run(b.id)).error).toBe(
        'Pero stopped before the run finished; not retried: Agent coach is disabled',
      );
      expect(await allRuns()).toHaveLength(2);
    });

    it('queues one retry however often it recovers a run', async () => {
      await manualWorkflow('brief');
      await workflows.edit('brief', { maxAttempts: 2 });
      const { id } = await stopMidRun('brief');
      await restart();
      const [, retry] = await allRuns();

      // As if recording the run had not been committed.
      await ds.getRepository(WorkflowRun).update(id, { status: 'running' });
      await executor.recover();

      expect(await allRuns()).toHaveLength(2);
      expect(await run(id)).toMatchObject({
        status: 'interrupted',
        error: `Pero stopped before the run finished; run ${retry!.id} retries it (attempt 2 of 2)`,
      });
    });
  });

  describe('cancelling', () => {
    it('cancels a pending run before it starts', async () => {
      await settings.update({ maxConcurrentRuns: 1 });
      await manualWorkflow('a');
      await manualWorkflow('b');
      const held = claude.hold();
      await runs.start('a');
      const b = await runs.start('b');
      await held.started;

      const cancelled = await runs.cancel(b.id);
      held.release();
      await executor.idle();

      expect(cancelled).toMatchObject({
        status: 'cancelled',
        startedAt: null,
        error: CANCELLED,
      });
      expect(cancelled.finishedAt).not.toBeNull();
      expect(await run(b.id)).toMatchObject({ status: 'cancelled' });
      expect(claude.requests).toHaveLength(1);
    });

    it("aborts a running run's Agent and records it cancelled", async () => {
      await manualWorkflow('brief');
      const held = claude.hold();
      const first = await runs.start('brief');
      const second = await runs.start('brief');
      const request = await held.started;

      const cancelling = await runs.cancel(first.id);
      expect(cancelling.status).toBe('running');
      await executor.idle();

      // Cancellation reaches the runtime.
      expect(request.signal.aborted).toBe(true);
      expect(await run(first.id)).toMatchObject({
        status: 'cancelled',
        result: null,
        error: CANCELLED,
      });
      // The Workflow's next run starts once it is free.
      expect(await run(second.id)).toMatchObject({ status: 'completed' });
    });

    it('records a run cancelled while Pero stops cancelled, not left for recovery', async () => {
      await manualWorkflow('brief');
      const held = claude.hold();
      const { id } = await runs.start('brief');
      await held.started;

      const drained = moduleRef.get(AgentManager).drain(10_000);
      await runs.cancel(id);
      await drained;
      await executor.idle();

      expect((await run(id)).status).toBe('cancelled');
    });

    it('refuses a run that has finished, or does not exist', async () => {
      await manualWorkflow('brief');
      const { id } = await runs.start('brief');
      await executor.idle();

      await expect(runs.cancel(id)).rejects.toThrow(
        new ConflictError(`Run ${id} has already finished (completed)`),
      );
      await expect(runs.cancel(99)).rejects.toThrow(
        new NotFoundError('No run with ID 99'),
      );
    });
  });

  it('fails a queued run whose Workflow was disabled before it started', async () => {
    await settings.update({ maxConcurrentRuns: 1 });
    await manualWorkflow('a');
    await manualWorkflow('b');
    const held = claude.hold();
    await runs.start('a');
    const b = await runs.start('b');
    await held.started;

    await workflows.edit('b', { enabled: false });
    held.release();
    await executor.idle();

    expect(await run(b.id)).toMatchObject({
      status: 'failed',
      startedAt: null,
      error: 'Workflow b was disabled before the run started',
    });
    expect(claude.requests).toHaveLength(1);
  });

  it('starts runs left pending when Pero last stopped', async () => {
    await manualWorkflow('brief');
    const workflow = await workflows.get('brief');
    const repo = ds.getRepository(WorkflowRun);
    const { id } = await repo.save(
      repo.create({
        workflowId: workflow.id,
        triggerId: null,
        triggerKey: 'manual:left-over',
        status: 'pending',
        attempt: 1,
      }),
    );

    await moduleRef.close();
    await boot();
    await executor.idle();

    expect((await run(id)).status).toBe('completed');
  });

  describe('history input', () => {
    let adapter: FakeChannelAdapter;

    beforeEach(async () => {
      await settings.update({ timezone: 'UTC' });
      for (const chat of [OWNER, HOME]) {
        await moduleRef.get(AllowedChatsService).allow({
          integrationKind: 'telegram',
          chatKey: chat.key,
          kind: chat.kind,
          title: chat.title,
        });
      }
      adapter = new FakeChannelAdapter();
      await moduleRef.get(ChannelRouter).connect(adapter);
    });

    /** A message in the English topic, or `topic` of HOME, and its reply. */
    async function say(text: string, topic = '7'): Promise<void> {
      const title = topic === '7' ? 'English' : `Topic ${topic}`;
      await adapter.deliver(inboundMessage(HOME, { topic, title, text }));
      await (moduleRef.get(ChannelTurns) as AgentChannelTurns).idle();
    }

    async function channelId(key: string): Promise<number> {
      return (
        await ds.getRepository(Channel).findOneByOrFail({ externalKey: key })
      ).id;
    }

    /** `review`, which reads history with `history`, run by hand. */
    async function historyWorkflow(
      history: WorkflowHistoryPatch = {},
    ): Promise<void> {
      await workflows.create({
        name: 'review',
        agent: 'coach',
        inputTemplate: 'Review:\n{{history}}',
        history,
      });
      await triggers.add({ workflow: 'review', kind: 'manual' });
    }

    /**
     * Runs `review` once: the run, the input its Agent got (undefined when
     * it was not asked), and the window it read.
     */
    async function runReview(): Promise<{
      view: RunView;
      input: string | undefined;
      window: HistoryRead;
    }> {
      const asked = claude.requests.length;
      const { id } = await runs.start('review');
      await executor.idle();
      return {
        view: await run(id),
        input:
          claude.requests.length > asked
            ? claude.requests.at(-1)!.input
            : undefined,
        window: await windowOf(id),
      };
    }

    async function windowOf(id: number): Promise<HistoryRead> {
      const { executionConfig } = await ds
        .getRepository(WorkflowRun)
        .findOneByOrFail({ id });
      return executionConfig!.history as HistoryRead;
    }

    it('reads each message once across consecutive runs, in adjacent windows', async () => {
      await say('I goed home');
      await say('She have two cats');
      await historyWorkflow();

      const first = await runReview();
      expect(first.view.status).toBe('completed');
      const lines = first.input!.split('\n');
      expect(lines[0]).toBe('Review:');
      expect(lines[1]).toBe('[Chat history]');
      expect(lines[2]).toMatch(
        /^\d{4}-\d\d-\d\d \d\d:\d\d \[English\] User: I goed home$/,
      );
      expect(lines[3]).toMatch(/ \[English\] User: She have two cats$/);
      expect(lines[4]).toBe('[End of chat history]');
      expect(lines).toHaveLength(5);
      expect(first.window).toMatchObject({
        channels: 'all',
        messages: 'people',
        afterId: null,
        count: 2,
        dropped: 0,
      });
      expect(first.window.since).not.toBeNull();

      await say('We was late');
      const second = await runReview();
      expect(second.input).toContain('User: We was late');
      expect(second.input).not.toContain('goed');
      expect(second.input).not.toContain('two cats');
      expect(second.window).toMatchObject({
        afterId: first.window.untilId,
        since: null,
        count: 1,
      });
    });

    it('reads the last 24 hours on its first run', async () => {
      await say('Yesterday morning');
      await say('Just now');
      const messages = ds.getRepository(Message);
      const old = await messages.findOneByOrFail({ text: 'Yesterday morning' });
      await messages.update(old.id, {
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });
      await historyWorkflow();

      const { input } = await runReview();

      expect(input).toContain('User: Just now');
      expect(input).not.toContain('Yesterday morning');
    });

    it('reads a fixed window of hours on every run', async () => {
      await say('Once');
      await historyWorkflow({ hours: 1 });

      expect((await runReview()).input).toContain('User: Once');
      const second = await runReview();
      expect(second.input).toContain('User: Once');
      expect(second.window).toMatchObject({ afterId: null, count: 1 });
    });

    it("keeps to the Channels it names, and adds the Agents' replies when asked", async () => {
      await say('In English');
      await say('Buy milk', '8');
      const english = await channelId(`${HOME.key}:7`);
      await historyWorkflow({ channels: [english], messages: 'all' });

      const { input, window } = await runReview();

      expect(input).toContain('[English] User: In English');
      expect(input).toContain('[English] english: echo: In English');
      expect(input).not.toContain('Buy milk');
      // Pero's own notices, such as the welcome, are left out.
      expect(input).not.toContain('pero agents edit');
      expect(window).toMatchObject({ channels: [english], messages: 'all' });
      expect(window.count).toBe(2);
    });

    it('keeps the newest messages within the budget', async () => {
      await say(`first ${'a'.repeat(30_000)}`);
      await say(`second ${'b'.repeat(30_000)}`);
      await historyWorkflow();

      const { input, window } = await runReview();

      expect(input).toContain('[1 earlier message left out to fit]');
      expect(input).toContain('User: second');
      expect(input).not.toContain('User: first');
      expect(window).toMatchObject({ count: 2, dropped: 1 });
    });

    it('completes a run with an empty window without its Agent, and reads after it next time', async () => {
      await say('Before the Workflow');
      await historyWorkflow({ hours: null });
      // The first window is taken, so the next is empty.
      await runReview();

      const empty = await runReview();
      expect(empty.view).toMatchObject({
        status: 'completed',
        skipped: true,
        result: null,
        error: null,
      });
      expect(empty.input).toBeUndefined();
      expect(empty.window.count).toBe(0);

      await say('After it');
      const next = await runReview();
      expect(next.input).toContain('User: After it');
      expect(next.input).not.toContain('Before the Workflow');
      expect(next.window.afterId).toBe(empty.window.untilId);
    });

    it('runs the Agent on an empty window when the Workflow asks to', async () => {
      await historyWorkflow({ runWhenEmpty: true });

      const { view, input } = await runReview();

      expect(view).toMatchObject({ status: 'completed', skipped: false });
      expect(input).toBe('Review:\n[No messages in this window]');
    });

    it('reads again the messages of a run that failed', async () => {
      await say('One');
      await historyWorkflow();
      claude.failNext();
      expect((await runReview()).view.status).toBe('failed');

      await say('Two');
      const { input } = await runReview();
      expect(input).toContain('User: One');
      expect(input).toContain('User: Two');
    });

    it('gives a retry the window of the run it retries, ahead of runs queued before it', async () => {
      await say('Before the crash');
      await historyWorkflow();
      await workflows.edit('review', { maxAttempts: 2 });
      const workflow = await workflows.get('review');
      const messages = ds.getRepository(Message);
      const crashedUntil = (
        await messages.findOneByOrFail({ text: 'Before the crash' })
      ).id;
      await say('After the crash');
      const repo = ds.getRepository(WorkflowRun);
      // Queued first, so only the retry's attempt puts that ahead of it.
      const queued = await repo.save(
        repo.create({
          workflowId: workflow.id,
          triggerId: null,
          triggerKey: 'manual:queued',
          status: 'pending',
          attempt: 1,
        }),
      );
      const crashed = await repo.save(
        repo.create({
          workflowId: workflow.id,
          triggerId: null,
          triggerKey: 'manual:crashed',
          status: 'running',
          attempt: 1,
          startedAt: new Date(),
          executionConfig: {
            history: {
              channels: 'all',
              messages: 'people',
              runWhenEmpty: false,
              afterId: null,
              since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              untilId: crashedUntil,
              count: 1,
              dropped: 0,
            },
          },
        }),
      );
      const asked = claude.requests.length;

      await moduleRef.close();
      await boot();
      await executor.idle();

      const retry = await ds.getRepository(WorkflowRun).findOneByOrFail({
        triggerKey: `retry:${crashed.id}`,
      });
      expect(retry.status).toBe('completed');
      const retryWindow = await windowOf(retry.id);
      expect(retryWindow).toMatchObject({
        afterId: null,
        untilId: crashedUntil,
        count: 1,
      });
      const [retryInput, queuedInput] = claude.requests
        .slice(asked)
        .map((request) => request.input);
      expect(retryInput).toContain('User: Before the crash');
      expect(retryInput).not.toContain('After the crash');
      expect(queuedInput).toContain('User: After the crash');
      expect(queuedInput).not.toContain('Before the crash');
      expect(await windowOf(queued.id)).toMatchObject({
        afterId: crashedUntil,
      });
    });
  });

  describe('starting a run by hand', () => {
    it('refuses an unknown Workflow', async () => {
      await expect(runs.start('nope')).rejects.toThrow(NotFoundError);
    });

    it('refuses a Workflow without a manual Trigger', async () => {
      await workflows.create({
        name: 'brief',
        agent: 'coach',
        inputTemplate: 'Go.',
      });
      await triggers.add({
        workflow: 'brief',
        kind: 'schedule',
        cron: '@daily',
      });

      await expect(runs.start('brief')).rejects.toThrow(
        new InvalidInputError(
          'Workflow brief has no manual Trigger; add one with pero triggers add brief --manual',
        ),
      );
      expect(await ds.getRepository(WorkflowRun).count()).toBe(0);
    });

    it('refuses while the manual Trigger, the Workflow, or its Agent is disabled', async () => {
      await manualWorkflow('brief');
      const [manual] = await triggers.list('brief');

      await triggers.setEnabled(manual!.id, false);
      await expect(runs.start('brief')).rejects.toThrow(
        `The manual Trigger of Workflow brief is disabled; enable it with pero triggers enable ${manual!.id}`,
      );
      await triggers.setEnabled(manual!.id, true);

      await workflows.edit('brief', { enabled: false });
      await expect(runs.start('brief')).rejects.toThrow(
        'Workflow brief is disabled; enable it first with pero workflows enable brief',
      );
      await workflows.edit('brief', { enabled: true });

      await agents.edit('coach', { enabled: false });
      await expect(runs.start('brief')).rejects.toThrow(
        'Agent coach is disabled; enable it first with pero agents enable coach',
      );
      expect(await ds.getRepository(WorkflowRun).count()).toBe(0);
    });

    it('gives each run its own trigger key and records when the Trigger last ran', async () => {
      await manualWorkflow('brief');

      const first = await runs.start('brief');
      const second = await runs.start('brief');
      await executor.idle();

      expect(first.triggerKey).not.toBe(second.triggerKey);
      const trigger = await ds
        .getRepository(Trigger)
        .findOneByOrFail({ kind: 'manual' });
      expect(first.triggerId).toBe(trigger.id);
      expect(trigger.lastRunAt).not.toBeNull();
    });

    it('refuses an unknown run ID', async () => {
      await expect(runs.get(99)).rejects.toThrow(
        new NotFoundError('No run with ID 99'),
      );
    });
  });
});
