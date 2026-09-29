import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsService } from '../agents/agents.service.js';
import type { AgentChannelTurns } from '../channels/agent-channel-turns.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { ChannelTurns } from '../channels/channel-stages.js';
import { ChannelsModule } from '../channels/channels.module.js';
import {
  FakeChannelAdapter,
  inboundMessage,
  privateChat,
} from '../channels/testing/fake-channel-adapter.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { Notification } from '../persistence/entities/notification.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { WorkflowExecutor } from '../workflows/workflow-executor.js';
import { WorkflowRuns } from '../workflows/workflow-runs.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  NOT_ALLOWED,
  NotificationDelivery,
  retryDelay,
} from './notification-delivery.js';
import { NotificationsModule } from './notifications.module.js';

const OWNER = privateChat('1234');

/** What run `brief` posts: the Workflow's name over the echoed input. */
const SUGGESTION = 'Workflow brief\n\necho: Suggest one thing.';

describe('NotificationDelivery', () => {
  let tmp: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let delivery: NotificationDelivery;
  let workflows: WorkflowsService;
  let adapter: FakeChannelAdapter;
  let claude: FakeAgentRuntime;
  let codex: FakeAgentRuntime;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-delivery-'));
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    claude = new FakeAgentRuntime('claude');
    codex = new FakeAgentRuntime('codex');
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        ChannelsModule,
        WorkflowsModule,
        TriggersModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([claude, codex])
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    delivery = moduleRef.get(NotificationDelivery);
    workflows = moduleRef.get(WorkflowsService);
    await moduleRef.get(SettingsService).update({
      defaultProvider: 'claude',
      defaultWorkingDirectory: vault,
    });
    await moduleRef.get(AgentsService).create({ name: 'coach' });
    await workflows.create({
      name: 'brief',
      agent: 'coach',
      inputTemplate: 'Suggest one thing.',
    });
    await moduleRef
      .get(TriggersService)
      .add({ workflow: 'brief', kind: 'manual' });
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
    rmSync(tmp, { recursive: true, force: true });
  });

  /** The owner's direct chat as a Channel `brief` notifies. */
  async function target(): Promise<Channel> {
    const coach = await moduleRef.get(AgentsService).get('coach');
    const channels = ds.getRepository(Channel);
    const channel = await channels.save(
      channels.create({
        integrationKind: 'telegram',
        externalKey: OWNER.key,
        address: OWNER.address,
        title: null,
        agentId: coach.id,
      }),
    );
    await workflows.notify('brief', channel.id);
    return channel;
  }

  /** Runs `brief` to its end; its Notification, due when it finished. */
  async function finishedRun(): Promise<Notification> {
    const { id } = await moduleRef.get(WorkflowRuns).start('brief');
    await moduleRef.get(WorkflowExecutor).idle();
    return ds
      .getRepository(Notification)
      .findOneByOrFail({ workflowRunId: id });
  }

  function reload(notification: Notification): Promise<Notification> {
    return ds
      .getRepository(Notification)
      .findOneByOrFail({ id: notification.id });
  }

  function workflowMessages(): Promise<Message[]> {
    return ds
      .getRepository(Message)
      .find({ where: { origin: 'workflow' }, order: { id: 'ASC' } });
  }

  const after = (date: Date, ms: number) => new Date(date.getTime() + ms);

  it('delivers a pending Notification and records it in history once', async () => {
    const channel = await target();
    const notification = await finishedRun();
    const now = after(notification.nextAttemptAt!, 1);

    await delivery.tick(now);
    await delivery.tick(after(now, 24 * 60 * 60_000));

    expect(adapter.sent).toEqual([
      { address: OWNER.address, message: { text: SUGGESTION } },
    ]);
    expect(await reload(notification)).toMatchObject({
      status: 'delivered',
      attempt: 1,
      providerMessageId: '1',
      nextAttemptAt: null,
      lastError: null,
    });
    expect(await workflowMessages()).toEqual([
      expect.objectContaining({
        channelId: channel.id,
        agentId: null,
        sessionId: null,
        direction: 'out',
        externalMessageId: '1',
        senderId: null,
        text: SUGGESTION,
        notificationId: notification.id,
      }),
    ]);
    expect(await ds.getRepository(WorkflowRun).count()).toBe(1);
  });

  it('sends nothing before a Notification is due', async () => {
    await target();
    const notification = await finishedRun();

    await delivery.tick(after(notification.nextAttemptAt!, -1_000));

    expect(adapter.sent).toEqual([]);
    expect(await reload(notification)).toMatchObject({
      status: 'pending',
      attempt: 0,
    });
  });

  it('retries a failed attempt after its backoff, without another run', async () => {
    await target();
    const notification = await finishedRun();
    const first = after(notification.nextAttemptAt!, 1);
    adapter.failSends = true;

    await delivery.tick(first);
    expect(await reload(notification)).toMatchObject({
      status: 'pending',
      attempt: 1,
      lastError: 'Service unreachable',
      nextAttemptAt: after(first, retryDelay(1)),
    });

    adapter.failSends = false;
    await delivery.tick(after(first, retryDelay(1) - 1_000));
    expect(adapter.sent).toEqual([]);

    await delivery.tick(after(first, retryDelay(1)));
    expect(adapter.sent).toHaveLength(1);
    expect(await reload(notification)).toMatchObject({
      status: 'delivered',
      attempt: 2,
      lastError: null,
    });
    expect(await workflowMessages()).toHaveLength(1);
    expect(await ds.getRepository(WorkflowRun).count()).toBe(1);
  });

  it('fails a Notification that runs out of attempts, and leaves it failed', async () => {
    await target();
    const notification = await finishedRun();
    adapter.failSends = true;
    let now = after(notification.nextAttemptAt!, 1);

    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      await delivery.tick(now);
      now = after(now, retryDelay(attempt));
    }
    expect(await reload(notification)).toMatchObject({
      status: 'failed',
      attempt: MAX_DELIVERY_ATTEMPTS,
      nextAttemptAt: null,
      lastError: 'Service unreachable',
    });

    adapter.failSends = false;
    await delivery.tick(after(now, 7 * 24 * 60 * 60_000));
    expect(adapter.sent).toEqual([]);
    expect(await reload(notification)).toMatchObject({
      attempt: MAX_DELIVERY_ATTEMPTS,
    });
  });

  it('fails a Notification to a chat that is no longer allowed, without sending', async () => {
    await target();
    const notification = await finishedRun();
    await moduleRef.get(AllowedChatsService).deny('telegram', OWNER.key);

    await delivery.tick(after(notification.nextAttemptAt!, 1));

    expect(adapter.sent).toEqual([]);
    expect(await reload(notification)).toMatchObject({
      status: 'failed',
      attempt: 1,
      lastError: NOT_ALLOWED,
      nextAttemptAt: null,
    });
    expect(await workflowMessages()).toEqual([]);
  });

  it('delivers to a disabled Channel', async () => {
    const channel = await target();
    await ds.getRepository(Channel).update(channel.id, { enabled: false });
    const notification = await finishedRun();

    await delivery.tick(after(notification.nextAttemptAt!, 1));

    expect(adapter.sent).toHaveLength(1);
    expect((await reload(notification)).status).toBe('delivered');
  });

  it('sends a Notification once when ticks overlap', async () => {
    await target();
    const notification = await finishedRun();
    const now = after(notification.nextAttemptAt!, 1);

    await Promise.all([
      delivery.tick(now),
      delivery.tick(after(now, 60 * 60_000)),
    ]);

    expect(adapter.sent).toHaveLength(1);
    expect(await workflowMessages()).toHaveLength(1);
  });

  describe('in the Channel afterwards', () => {
    let channel: Channel;

    /** A message from the owner, answered before this resolves. */
    async function say(text: string): Promise<void> {
      await adapter.deliver(inboundMessage(OWNER, { text }));
      await (moduleRef.get(ChannelTurns) as AgentChannelTurns).idle();
    }

    /** Runs `brief` and delivers what it posts to the owner's chat. */
    async function posted(): Promise<void> {
      const notification = await finishedRun();
      await delivery.tick(after(notification.nextAttemptAt!, 1));
      expect((await reload(notification)).status).toBe('delivered');
    }

    beforeEach(async () => {
      // Onboards the direct chat, with the main Agent.
      await say('Hello');
      channel = await ds
        .getRepository(Channel)
        .findOneByOrFail({ externalKey: OWNER.key });
      await workflows.notify('brief', channel.id);
    });

    it('gives the next turn what was posted since the last message, and the turn after it nothing', async () => {
      await posted();

      await say('Tell me more');
      const input = claude.requests.at(-1)!.input;
      expect(input).toMatch(
        /^\[Posted in this chat by Workflows since the last message here\]\n\d{4}-\d\d-\d\d \d\d:\d\d Workflow brief: Workflow brief\n\necho: Suggest one thing\.\n\[End of posted messages\]\n\nTell me more$/,
      );
      expect(claude.requests.at(-1)!.providerSessionId).toBeDefined();

      await say('Thanks');
      expect(claude.requests.at(-1)!.input).toBe('Thanks');
    });

    it('gives a fresh Session the posted messages once, after the conversation it carries over', async () => {
      await posted();
      await moduleRef.get(AgentsService).edit('main', { provider: 'codex' });

      await say('Tell me more');
      const input = codex.requests.at(-1)!.input;
      expect(input).toContain('main: echo: Hello');
      expect(input.indexOf('[End of earlier conversation]')).toBeLessThan(
        input.indexOf('[Posted in this chat by Workflows'),
      );
      expect(input.split('Workflow brief: ')).toHaveLength(2);
      expect(input.endsWith('\n\nTell me more')).toBe(true);
    });

    it('carries over earlier Workflow messages into a fresh Session', async () => {
      await posted();
      await say('Tell me more');
      await moduleRef.get(AgentsService).edit('main', { provider: 'codex' });

      await say('And then?');
      const input = codex.requests.at(-1)!.input;
      expect(input).toMatch(
        /^\[Earlier conversation in this chat, from a previous session\]\n/,
      );
      expect(input).toContain('Workflow brief: Workflow brief\n\necho:');
      // Nothing was posted since the last message, so no block of its own.
      expect(input.endsWith('[End of earlier conversation]\n\nAnd then?')).toBe(
        true,
      );
    });

    it("leaves Workflow messages out of a Workflow's history window", async () => {
      await posted();
      await workflows.create({
        name: 'review',
        agent: 'coach',
        inputTemplate: 'Review:\n{{history}}',
        history: { messages: 'all', hours: 24 },
      });
      await moduleRef
        .get(TriggersService)
        .add({ workflow: 'review', kind: 'manual' });

      await moduleRef.get(WorkflowRuns).start('review');
      await moduleRef.get(WorkflowExecutor).idle();

      const input = claude.requests.at(-1)!.input;
      expect(input).toContain('Hello');
      expect(input).not.toContain('Suggest one thing');
    });
  });
});
