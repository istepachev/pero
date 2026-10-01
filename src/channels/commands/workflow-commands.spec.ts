import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../../agents/agents.module.js';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../../runtimes/agent-runtimes.js';
import { RuntimeError } from '../../runtimes/agent-runtime.js';
import { FakeAgentRuntime } from '../../runtimes/testing/fake-agent-runtime.js';
import { TestWorkspace } from '../../settings/testing/test-workspace.js';
import { WorkflowExecutor } from '../../workflows/workflow-executor.js';
import { WorkflowRuns } from '../../workflows/workflow-runs.service.js';
import { AllowedChatsService } from '../allowed-chats.service.js';
import { ChannelRouter } from '../channel-router.js';
import { ChannelsModule } from '../channels.module.js';
import {
  FakeChannelAdapter,
  inboundMessage,
  privateChat,
  type SentRecord,
} from '../testing/fake-channel-adapter.js';
import { workflowRef } from './workflow-screens.js';

const OWNER = privateChat('1234');

describe('Workflow commands', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule;
  let adapter: FakeChannelAdapter;
  let claude: FakeAgentRuntime;
  let runs: WorkflowRuns;
  let executor: WorkflowExecutor;

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-workflow-commands-');
    await ws.pero({ timezone: 'UTC' });
    await ws.agent('Main');
    claude = new FakeAgentRuntime('claude');
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        AgentsModule,
        ChannelsModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([claude, new FakeAgentRuntime('codex')])
      .compile();
    await moduleRef.init();
    ws.use(moduleRef);
    runs = moduleRef.get(WorkflowRuns);
    executor = moduleRef.get(WorkflowExecutor);
    await moduleRef.get(AllowedChatsService).allow({
      integrationKind: 'telegram',
      chatKey: OWNER.key,
      kind: OWNER.kind,
      title: OWNER.title,
    });
    adapter = new FakeChannelAdapter();
    await moduleRef.get(ChannelRouter).connect(adapter);
  });

  afterEach(async () => {
    await moduleRef.close();
    vi.restoreAllMocks();
    ws.delete();
  });

  /** Sends command `text` and resolves once Pero has answered it. */
  async function say(text: string): Promise<SentRecord> {
    const message = inboundMessage(OWNER, { text });
    const [name = '', ...args] = text.slice(1).split(' ');
    message.content.command = { name, args: args.join(' ') };
    await adapter.deliver(message);
    return adapter.sent.at(-1)!;
  }

  function labels(record: { message: SentRecord['message'] }) {
    return record.message.buttons?.map((row) => row.map((b) => b.label));
  }

  /** The last edit, as a press leaves it. */
  function edited() {
    return adapter.edited.at(-1)!;
  }

  /** The message a press acts on: the latest edit, else the latest sent. */
  function latest() {
    return adapter.edited.at(-1) ?? adapter.sent.at(-1)!;
  }

  it('lists the Workflows with their schedule and latest run, and opens one', async () => {
    await ws.workflow('Daily brief', { hour: 18, timezone: 'UTC' });
    await ws.workflow('Cleanup', {});
    await runs.start('cleanup');
    await executor.idle();

    const list = await say('/workflows');

    expect(list.message.text).toMatch(
      /^Workflows:\n• Cleanup — by hand only · last run #1 completed \S+ \S+\n• Daily brief — (next|not scheduled)/,
    );
    expect(labels(list)).toEqual([['Cleanup', 'Daily brief']]);

    await adapter.press(list, 'Cleanup', OWNER);
    expect(edited().message.text).toMatch(
      /^Workflow Cleanup\nConfig: data\/Settings\/Workflows\/Cleanup\.md\nAgent: main\nSchedule: none, it runs by hand\nPosts to: no topic\nLatest runs:\n {2}#1 completed /,
    );
    expect(labels(edited())).toEqual([['Run now', 'Runs'], ['« Workflows']]);
  });

  it('runs a Workflow by name or title, from a button too', async () => {
    await ws.workflow('Daily brief', {});

    await say('/run daily brief');
    expect(adapter.sent.at(-1)!.message.text).toBe(
      'Queued run #1 of Daily brief.',
    );
    await executor.idle();
    expect(claude.requests.at(-1)!.input).toContain('Run Daily brief.');

    await say('/workflows Daily-Brief');
    const result = await adapter.press(latest(), 'Run now', OWNER);
    expect(result).toEqual({ notice: 'Run queued' });
    expect(edited().message.text).toBe('Queued run #2 of Daily brief.\n— @ada');
    expect(labels(edited())).toEqual([['Run #2', 'Runs'], ['« Workflows']]);
  });

  it('offers the Workflows when /run names none, or one that does not exist', async () => {
    await ws.workflow('Daily brief', {});

    const picker = await say('/run');
    expect(picker.message.text).toMatch(
      /^Which Workflow should run now\?\n• Daily brief/,
    );
    expect(picker.message.buttons?.flat()[0]).toEqual({
      id: '/run daily-brief',
      label: 'Daily brief',
    });

    const unknown = await say('/run weekly');
    expect(unknown.message.text).toMatch(
      /^There is no Workflow weekly\.\nWhich Workflow should run now\?/,
    );

    await adapter.press(unknown, 'Daily brief', OWNER);
    expect(edited().message.text).toBe('Queued run #1 of Daily brief.\n— @ada');
  });

  it('says how to add a Workflow when there is none', async () => {
    expect((await say('/run')).message.text).toBe(
      'No Workflows yet. Ask an Agent to create one, or add a note to data/Settings/Workflows/.',
    );
  });

  it('shows the latest runs and one run, with Retry for a failed one', async () => {
    await ws.workflow('Daily brief', {});
    claude.failNext(new RuntimeError('failed', 'The model is overloaded'));
    await runs.start('daily-brief');
    await executor.idle();

    const list = await say('/runs');
    expect(list.message.text).toMatch(
      /^Latest runs:\n• #1 Daily brief failed /,
    );
    await adapter.press(list, '#1 failed', OWNER);
    expect(edited().message.text).toMatch(
      /^Run #1 of Daily brief: failed\nQueued .* · started .* · finished .*\nError: /,
    );
    expect(labels(edited())).toEqual([['Retry'], ['« Runs', '« Workflows']]);

    const result = await adapter.press(edited(), 'Retry', OWNER);
    expect(result).toEqual({ notice: 'Retry queued' });
    expect(edited().message.text).toBe(
      'Queued run #2 of Daily brief, retrying run #1.\n— @ada',
    );
    await executor.idle();

    // A run is retried once.
    const again = await say('/retry 1');
    expect(again.message.text).toMatch(
      /^Run 1 is already retried by run 2; retry that one instead\.\nNo run failed/,
    );
  });

  it('offers only the runs that can be cancelled or retried', async () => {
    await ws.workflow('Daily brief', {});
    claude.failNext(new RuntimeError('failed', 'The model is overloaded'));
    await runs.start('daily-brief');
    await executor.idle();
    const held = claude.hold();
    await runs.start('daily-brief');
    await held.started;

    const cancel = await say('/cancel');
    expect(cancel.message.text).toMatch(
      /^Which run should be cancelled\?\n• #2 Daily brief running /,
    );
    expect(labels(cancel)).toEqual([['#2 running'], ['« Workflows']]);
    const retry = await say('/retry');
    expect(labels(retry)).toEqual([['#1 failed'], ['« Workflows']]);

    const result = await adapter.press(cancel, '#2 running', OWNER);
    expect(result).toEqual({ notice: 'Cancelled' });
    expect(edited().message.text).toBe(
      'Cancelling run #2 of Daily brief: its Agent is stopping.\n— @ada',
    );
    await executor.idle();
    expect((await runs.get(2)).status).toBe('cancelled');

    expect((await say('/cancel 2')).message.text).toMatch(
      /^Run 2 has already finished \(cancelled\)\.\nNo run is waiting or running/,
    );
    expect((await say('/cancel soon')).message.text).toMatch(
      /^soon isn't a run's number\./,
    );
  });

  it('says when a run does not exist, and a Workflow that has no runs', async () => {
    await ws.workflow('Daily brief', {});

    expect((await say('/runs #9')).message.text).toBe(
      'There is no run #9.\nNo runs yet.',
    );
    expect((await say('/runs Daily brief')).message.text).toBe(
      'No runs of Daily brief yet.',
    );
    expect((await say('/runs nope')).message.text).toMatch(
      /^There is no Workflow nope\.\nWhose runs\?/,
    );
  });

  it('names a Workflow too long for a button by a hash', () => {
    const long = 'a'.repeat(60);

    expect(workflowRef('daily-brief')).toBe('daily-brief');
    expect(workflowRef(long)).toMatch(/^~[\w-]{10}$/);
    expect(
      Buffer.byteLength(`/workflows ${workflowRef(long)}`),
    ).toBeLessThanOrEqual(64);
  });
});
