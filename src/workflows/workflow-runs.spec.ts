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
  inboundMessage,
  privateChat,
} from '../channels/testing/fake-channel-adapter.js';
import { InvalidInputError, NotFoundError } from '../common/errors.js';
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
import { WorkflowExecutor } from './workflow-executor.js';
import { WorkflowRuns } from './workflow-runs.service.js';
import { WorkflowsModule } from './workflows.module.js';
import { WorkflowsService } from './workflows.service.js';

const OWNER = privateChat('1234');

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

  it('records a run that Pero stopped as interrupted', async () => {
    await manualWorkflow('brief');
    const held = claude.hold();
    const { id } = await runs.start('brief');
    const request = await held.started;

    await moduleRef.get(AgentManager).drain(10);
    await executor.idle();

    expect(request.signal.aborted).toBe(true);
    expect(await run(id)).toMatchObject({
      status: 'interrupted',
      error: 'Pero stopped before the run finished',
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
