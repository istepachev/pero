import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../../agents/agents.module.js';
import { Channel } from '../../persistence/entities/channel.entity.js';
import { Message } from '../../persistence/entities/message.entity.js';
import { Session } from '../../persistence/entities/session.entity.js';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../../runtimes/testing/fake-agent-runtime.js';
import { TestWorkspace } from '../../settings/testing/test-workspace.js';
import type { AgentChannelTurns } from '../agent-channel-turns.js';
import { AllowedChatsService } from '../allowed-chats.service.js';
import type { InboundChat } from '../channel-adapter.js';
import { ChannelRouter } from '../channel-router.js';
import { ChannelTurns } from '../channel-stages.js';
import { ChannelsModule } from '../channels.module.js';
import {
  buttonPress,
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  privateChat,
  type SentRecord,
} from '../testing/fake-channel-adapter.js';

const GROUP = groupChat('-100777', 'Household');
const OWNER = privateChat('1234');

describe('ChannelCommands', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let adapter: FakeChannelAdapter;
  let claude: FakeAgentRuntime;

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-commands-');
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
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    ws.use(moduleRef);
    for (const chat of [GROUP, OWNER]) {
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

  afterEach(async () => {
    await moduleRef.close();
    vi.restoreAllMocks();
    ws.delete();
  });

  function idle(): Promise<void> {
    return (moduleRef.get(ChannelTurns) as AgentChannelTurns).idle();
  }

  /**
   * Sends `text` in `chat`, as a command when it starts with `/`, which
   * is answered by the time it resolves; waits for the Agent otherwise.
   */
  async function say(chat: InboundChat, text: string, topic?: string) {
    const message = inboundMessage(chat, { text, topic });
    if (!text.startsWith('/')) {
      await adapter.deliver(message);
      return idle();
    }
    const [name = '', ...args] = text.slice(1).split(' ');
    message.content.command = { name, args: args.join(' ') };
    await adapter.deliver(message);
  }

  function last(): SentRecord {
    return adapter.sent.at(-1)!;
  }

  function labels(record: SentRecord | { message: SentRecord['message'] }) {
    return record.message.buttons?.map((row) => row.map((b) => b.label));
  }

  async function channelFor(chat: InboundChat): Promise<Channel> {
    return ds
      .getRepository(Channel)
      .findOneByOrFail({ integrationKind: 'telegram', externalKey: chat.key });
  }

  describe('/status', () => {
    it('shows the Agent, its config, Session, context, and Pero, with no Agent turn and no history', async () => {
      await say(OWNER, 'Hello');
      claude.usage = { contextTokens: 84_000, contextWindow: 200_000 };
      await say(OWNER, 'Again');
      const messages = await ds.getRepository(Message).count();

      await say(OWNER, '/status');

      const lines = last().message.text.split('\n');
      expect(lines[0]).toBe('Agent main');
      expect(lines[1]).toMatch(
        /^State: idle · last answer \d{4}-\d\d-\d\d \d\d:\d\d$/,
      );
      expect(lines.slice(2, 6)).toEqual([
        'Config: data/Settings/Agents/Main.md',
        'Provider: claude (default) · default model · default effort',
        'Permissions: ask (default)',
        'Folder: the workspace',
      ]);
      expect(lines[6]).toMatch(/^Session: #1 since .* · 2 turns$/);
      expect(lines[7]).toBe('Context: ~84k of 200k tokens (42%)');
      expect(lines.at(-1)).toMatch(
        /^Pero: claude \w+ · codex \w+ · .*telegram/,
      );
      expect(labels(last())).toEqual([['New session', 'Refresh']]);
      expect(claude.requests).toHaveLength(2);
      expect(await ds.getRepository(Message).count()).toBe(messages);
    });

    it('says the Agent is answering, and offers to stop it', async () => {
      await say(OWNER, 'Hello');
      const held = claude.hold();
      await adapter.deliver(inboundMessage(OWNER, { text: 'Think hard' }));
      await held.started;

      await say(OWNER, '/status');

      expect(last().message.text).toMatch(/\nState: answering for \d+s\n/);
      expect(labels(last())).toEqual([['Stop', 'New session', 'Refresh']]);
      held.release();
      await idle();
    });

    it('says why no one answers, and what to edit', async () => {
      await ws.editAgent('Main', { enabled: false });

      await say(OWNER, '/status');

      expect(last().message.text).toMatch(
        /^Agent main is disabled, so no one answers here\. To turn it back on, set enabled: true in data\/Settings\/Agents\/Main\.md\.\n\nPero: /,
      );
      expect(claude.requests).toEqual([]);
    });
  });

  describe('/new', () => {
    it('starts a fresh Session that carries nothing from before', async () => {
      await say(OWNER, 'one');
      await say(OWNER, 'two');

      await say(OWNER, '/new');
      expect(last().message.text).toBe(
        "Started over: Agent main's next answer here begins a new conversation.",
      );
      await say(OWNER, '/status');
      expect(last().message.text).toContain(
        '\nSession: none: the next message starts a new one, after /new\n',
      );
      await say(OWNER, 'three');

      expect(claude.requests.at(-1)).toMatchObject({ input: 'three' });
      expect(claude.requests.at(-1)).not.toHaveProperty('providerSessionId');
      const sessions = await ds
        .getRepository(Session)
        .find({ order: { id: 'ASC' } });
      expect(sessions.map((session) => session.status)).toEqual([
        'closed',
        'active',
      ]);
    });

    it('stops an answer in progress, which then posts nothing', async () => {
      await say(OWNER, 'Hello');
      const held = claude.hold();
      await adapter.deliver(inboundMessage(OWNER, { text: 'Think hard' }));
      const request = await held.started;

      await say(OWNER, '/new');

      expect(request.signal.aborted).toBe(true);
      expect(last().message.text).toBe(
        "Started over: Agent main's next answer here begins a new conversation. " +
          'Its answer in progress was stopped.',
      );
    });

    it('asks first from a button, and names who confirmed', async () => {
      await say(OWNER, 'Hello');
      await say(OWNER, '/status');
      const status = last();

      await adapter.press(status, 'New session', OWNER);
      const confirm = adapter.edited.at(-1)!;
      expect(confirm.message.text).toMatch(
        /^Start over with Agent main here\?/,
      );
      expect(labels(confirm)).toEqual([['Yes, start over', 'Cancel']]);
      expect(
        await ds.getRepository(Session).countBy({ status: 'active' }),
      ).toBe(1);

      const result = await adapter.act(
        buttonPress(OWNER, {
          actionId: '/new yes',
          messageId: confirm.messageId,
          senderName: '@ada',
        }),
      );

      expect(result).toEqual({ notice: 'Started over' });
      expect(adapter.edited.at(-1)!.message).toEqual({
        text: "Started over: Agent main's next answer here begins a new conversation.\n— @ada",
        buttons: [[{ id: '/status', label: '« Back' }]],
      });
      expect(
        await ds.getRepository(Session).countBy({ status: 'active' }),
      ).toBe(0);
    });

    it('refuses where no Agent answers, saying why', async () => {
      await ws.editAgent('Main', { enabled: false });

      await say(OWNER, '/new');

      expect(last().message.text).toMatch(/^Agent main is disabled/);
    });
  });

  describe('/stop', () => {
    it("stops the Agent's answer and the waiting ones, without a failure notice", async () => {
      await say(OWNER, 'Hello');
      const held = claude.hold();
      await adapter.deliver(inboundMessage(OWNER, { text: 'one' }));
      const request = await held.started;
      await adapter.deliver(inboundMessage(OWNER, { text: 'two' }));

      await say(OWNER, '/stop');

      expect(request.signal.aborted).toBe(true);
      expect(adapter.sent.map((sent) => sent.message.text).slice(-2)).toEqual([
        'echo: Hello',
        "Stopped Agent main's answer. 1 waiting message won't be answered.",
      ]);
      expect(claude.requests.map((r) => r.input)).toEqual(['Hello', 'one']);
    });

    it('says when there is nothing to stop', async () => {
      await say(OWNER, '/stop');

      expect(last().message.text).toBe(
        "Agent main isn't answering anything here.",
      );
    });
  });

  it('lists the commands with /help', async () => {
    await say(OWNER, '/help');

    expect(last().message.text).toContain('/status — ');
    expect(labels(last())).toEqual([['Status', 'New session', 'Stop']]);
  });

  it("answers a press in a Channel Pero doesn't know as expired", async () => {
    expect(
      await adapter.act(
        buttonPress(GROUP, {
          actionId: '/status',
          messageId: '3',
          topic: '99',
        }),
      ),
    ).toEqual({ notice: 'This menu has expired' });
  });

  it('leaves a channel the chat is new to onboarded', async () => {
    await say(OWNER, '/status');

    expect((await channelFor(OWNER)).externalKey).toBe(OWNER.key);
  });
});
