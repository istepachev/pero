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
import { TestWorkspace } from '../../system/testing/test-workspace.js';
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
    await ws.channel('Default');
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
   * is answered by the time it resolves; waits for the turn otherwise.
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
    it('shows the Channel, its config, Session, context, and Pero, with no turn and no history', async () => {
      await say(OWNER, 'Hello');
      claude.usage = { contextTokens: 84_000, contextWindow: 200_000 };
      await say(OWNER, 'Again');
      const messages = await ds.getRepository(Message).count();

      await say(OWNER, '/status');

      const lines = last().message.text.split('\n');
      expect(lines[0]).toBe('Channel Default');
      expect(lines[1]).toMatch(
        /^State: idle · last answer \d{4}-\d\d-\d\d \d\d:\d\d$/,
      );
      expect(lines.slice(2, 6)).toEqual([
        'Config: data/System/Channels/Default.md',
        'Provider: claude (default) · default model · default effort',
        'Permissions: ask (default)',
        'Folder: the workspace',
      ]);
      expect(lines[6]).toMatch(/^Session: #1 since .* · 2 turns$/);
      expect(lines[7]).toBe('Context: ~84k of 200k tokens (42%)');
      expect(lines.at(-1)).toMatch(
        /^Pero: claude \w+ · codex \w+ · .*telegram/,
      );
      expect(labels(last())).toEqual([
        ['New session', 'Refresh'],
        ['Model', 'Effort'],
      ]);
      expect(claude.requests).toHaveLength(2);
      expect(await ds.getRepository(Message).count()).toBe(messages);
    });

    it('says Pero is answering, and offers to stop it', async () => {
      await say(OWNER, 'Hello');
      const held = claude.hold();
      await adapter.deliver(inboundMessage(OWNER, { text: 'Think hard' }));
      await held.started;

      await say(OWNER, '/status');

      expect(last().message.text).toMatch(/\nState: answering for \d+s\n/);
      expect(labels(last())).toEqual([
        ['Stop', 'New session', 'Refresh'],
        ['Model', 'Effort'],
      ]);
      held.release();
      await idle();
    });

    it('says why no one answers, and what to edit', async () => {
      await ws.editChannel('Default', { enabled: false });

      await say(OWNER, '/status');

      expect(last().message.text).toMatch(
        /^Pero doesn't answer here: data\/System\/Channels\/Default\.md sets enabled: false\. To turn it back on, set enabled: true there\.\n\nPero: /,
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
        "Started over: Pero's next answer here begins a new conversation.",
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
        "Started over: Pero's next answer here begins a new conversation. " +
          'Its answer in progress was stopped.',
      );
    });

    it('asks first from a button, and names who confirmed', async () => {
      await say(OWNER, 'Hello');
      await say(OWNER, '/status');
      const status = last();

      await adapter.press(status, 'New session', OWNER);
      const confirm = adapter.edited.at(-1)!;
      expect(confirm.message.text).toMatch(/^Start over here\?/);
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
        text: "Started over: Pero's next answer here begins a new conversation.\n— @ada",
        buttons: [[{ id: '/status', label: '« Back' }]],
      });
      expect(
        await ds.getRepository(Session).countBy({ status: 'active' }),
      ).toBe(0);
    });

    it("refuses where Pero doesn't answer, saying why", async () => {
      await ws.editChannel('Default', { enabled: false });

      await say(OWNER, '/new');

      expect(last().message.text).toMatch(/^Pero doesn't answer here/);
    });
  });

  describe('/stop', () => {
    it("stops Pero's answer and the waiting ones, without a failure notice", async () => {
      await say(OWNER, 'Hello');
      const held = claude.hold();
      await adapter.deliver(inboundMessage(OWNER, { text: 'one' }));
      const request = await held.started;
      await adapter.deliver(inboundMessage(OWNER, { text: 'two' }));

      await say(OWNER, '/stop');

      expect(request.signal.aborted).toBe(true);
      expect(adapter.sent.map((sent) => sent.message.text).slice(-2)).toEqual([
        'echo: Hello',
        "Stopped Pero's answer. 1 waiting message won't be answered.",
      ]);
      expect(claude.requests.map((r) => r.input)).toEqual(['Hello', 'one']);
    });

    it('says when there is nothing to stop', async () => {
      await say(OWNER, '/stop');

      expect(last().message.text).toBe("Pero isn't answering anything here.");
    });
  });

  describe('/effort and /model', () => {
    it("offers the provider's levels, and a press writes the note", async () => {
      await ws.pero({ timezone: 'UTC', 'claude-effort': 'medium' });
      await say(OWNER, '/effort');
      const picker = last();
      expect(picker.message.text).toBe(
        'This Channel uses effort medium (Pero.md).\n' +
          'Pick one. It applies from the next answer.',
      );
      expect(labels(picker)).toEqual([
        ['low', 'medium', 'high'],
        ['xhigh', 'max'],
        ['✓ Default (Pero.md: medium)'],
        ['« Back'],
      ]);

      const result = await adapter.press(picker, 'low', OWNER);

      expect(result).toEqual({ notice: 'Effort set' });
      expect(adapter.edited.at(-1)!.message.text).toBe(
        'This Channel now uses effort low, from the next answer.\n' +
          'Config: data/System/Channels/Default.md\n— @ada',
      );
      expect(ws.read('Channels/Default.md')).toMatch(/^effort: low$/m);
      await say(OWNER, 'Hello');
      expect(claude.requests.at(-1)!.providerOptions).toMatchObject({
        effort: 'low',
      });

      await adapter.press(adapter.edited.at(-1)!, '« Effort', OWNER);
      expect(labels(adapter.edited.at(-1)!)).toContainEqual([
        '✓ low',
        'medium',
        'high',
      ]);
    });

    it('goes back to the default, and says when nothing changes', async () => {
      await ws.editChannel('Default', { effort: 'high' });

      await say(OWNER, '/effort default');
      expect(last().message.text).toBe(
        'This Channel now uses default effort, from the next answer.\n' +
          'Config: data/System/Channels/Default.md',
      );
      expect(ws.read('Channels/Default.md')).not.toMatch(/^effort:/m);

      await say(OWNER, '/effort default');
      expect(last().message.text).toMatch(
        /^This Channel already uses default effort\./,
      );
    });

    it('shows the choices again for a level the provider lacks', async () => {
      await say(OWNER, '/effort ultra');

      expect(last().message.text).toMatch(
        /^There is no effort ultra for claude\.\nThis Channel uses default effort\./,
      );
      expect(ws.read('Channels/Default.md')).not.toMatch(/^effort:/m);
    });

    it('sets a typed model, and offers the ones the workspace uses', async () => {
      await ws.channel('Running', { model: 'claude-opus-4-8' });

      await say(OWNER, '/model sonnet');
      expect(last().message.text).toMatch(
        /^This Channel now uses model sonnet, from the next answer\./,
      );
      await say(OWNER, '/model');

      expect(labels(last())).toEqual([
        ['opus', '✓ sonnet', 'haiku'],
        ['claude-opus-4-8'],
        ["Default (provider's)"],
        ['« Back'],
      ]);
      await say(OWNER, '/status');
      expect(last().message.text).toContain(
        '\nProvider: claude (default) · model sonnet · default effort\n',
      );
    });

    it("leaves a note whose properties don't parse as it is", async () => {
      await say(OWNER, 'Hello');
      await ws.write('Channels/Default.md', '---\neffort: [\n---\nBe kind.\n');

      await say(OWNER, '/effort low');

      expect(last().message.text).toBe(
        "Channels/Default.md's properties don't parse; pero check lists the errors",
      );
      expect(ws.read('Channels/Default.md')).toBe(
        '---\neffort: [\n---\nBe kind.\n',
      );
    });

    it("refuses a model name with spaces, and a Channel Pero doesn't answer", async () => {
      await say(OWNER, '/model big one');
      expect(last().message.text).toMatch(
        /^A model's name has no spaces: big one\n/,
      );

      await ws.editChannel('Default', { enabled: false });
      await say(OWNER, '/effort low');
      expect(last().message.text).toMatch(/^Pero doesn't answer here/);
    });
  });

  it('lists the commands with /help', async () => {
    await say(OWNER, '/help');

    expect(last().message.text).toContain('/status — ');
    expect(labels(last())).toEqual([
      ['Status', 'New session', 'Stop'],
      ['Model', 'Effort', 'Workflows'],
    ]);
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
