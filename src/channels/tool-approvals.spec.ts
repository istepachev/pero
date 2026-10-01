import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { Message } from '../persistence/entities/message.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { TestWorkspace } from '../settings/testing/test-workspace.js';
import { AgentChannelTurns } from './agent-channel-turns.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type { InboundChat } from './channel-adapter.js';
import { ChannelRouter } from './channel-router.js';
import { ChannelTurns } from './channel-stages.js';
import { ChannelsModule } from './channels.module.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  privateChat,
  type SentRecord,
} from './testing/fake-channel-adapter.js';
import { TOOL_APPROVAL_TIMEOUT_MS } from './tool-approvals.js';

const GROUP = groupChat('-1009007199254740993', 'Household');
const OWNER = privateChat('1234');
const STRANGER = privateChat('999');

describe('ToolApprovals', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule;
  let adapter: FakeChannelAdapter;
  let claude: FakeAgentRuntime;
  let closed: boolean;

  async function boot(timeoutMs = 60_000) {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        AgentsModule,
        ChannelsModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([claude])
      .overrideProvider(TOOL_APPROVAL_TIMEOUT_MS)
      .useValue(timeoutMs)
      .compile();
    await moduleRef.init();
    closed = false;
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
  }

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-approvals-');
    await ws.agent('Main');
    claude = new FakeAgentRuntime('claude');
    await boot();
  });

  afterEach(async () => {
    if (!closed) await moduleRef.close();
    ws.delete();
  });

  function idle(): Promise<void> {
    return (moduleRef.get(ChannelTurns) as AgentChannelTurns).idle();
  }

  /** Sends `text` in `chat` and waits until the Agent asks about a tool. */
  async function askIn(chat: InboundChat, text = 'Hello'): Promise<SentRecord> {
    claude.askNext('Bash', 'Bash: curl -sI https://example.com');
    await adapter.deliver(inboundMessage(chat, { text }));
    return vi.waitFor(() => {
      const prompt = adapter.sent.find((sent) => sent.message.buttons);
      if (!prompt) throw new Error('No tool request yet');
      return prompt;
    });
  }

  function lastText(): string | undefined {
    return adapter.sent.at(-1)?.message.text;
  }

  it('asks in the Channel with Allow and Deny buttons', async () => {
    const prompt = await askIn(OWNER);

    expect(prompt.address).toEqual(OWNER.address);
    expect(prompt.message.text).toBe(
      'Agent main wants to use a tool:\nBash: curl -sI https://example.com',
    );
    expect(
      prompt.message.buttons?.flat().map((button) => button.label),
    ).toEqual(['Allow', 'Deny']);
  });

  it('runs the tool once someone allows it, and says who did', async () => {
    const prompt = await askIn(OWNER);

    expect(await adapter.press(prompt, 'Allow', OWNER)).toEqual({
      notice: 'Allowed',
    });
    await idle();

    expect(lastText()).toBe('echo: Hello (Bash allowed)');
    expect(adapter.edited).toEqual([
      {
        address: OWNER.address,
        messageId: String(adapter.sent.indexOf(prompt) + 1),
        message: {
          text: `${prompt.message.text}\n\n✅ Allowed by @ada`,
        },
      },
    ]);
  });

  it('tells the Agent when someone denies it', async () => {
    const prompt = await askIn(OWNER);

    expect(
      await adapter.press(prompt, 'Deny', OWNER, { senderName: null }),
    ).toEqual({ notice: 'Denied' });
    await idle();

    expect(lastText()).toBe('echo: Hello (Bash denied: the owner denied it)');
    expect(adapter.edited.at(-1)?.message.text).toMatch(
      /❌ Denied by user 42$/,
    );
  });

  it('denies a request no one answers in time', async () => {
    await moduleRef.close();
    await boot(1_000);

    await askIn(OWNER);
    await vi.waitFor(
      () =>
        expect(lastText()).toBe(
          'echo: Hello (Bash denied: no one answered within 1 second)',
        ),
      { timeout: 5_000 },
    );
    expect(adapter.edited.at(-1)?.message.text).toMatch(
      /⌛ Denied: no answer within 1 second$/,
    );
  });

  it('answers a press it no longer waits on, or from elsewhere, as expired', async () => {
    const prompt = await askIn(GROUP);

    // Another chat, even an allowed one, cannot answer.
    const wrongChat = {
      ...prompt,
      message: { ...prompt.message },
    };
    adapter.sent.push(wrongChat);
    expect(await adapter.press(wrongChat, 'Allow', OWNER)).toEqual({
      notice: 'This request has expired',
    });
    adapter.sent.pop();

    await adapter.press(prompt, 'Allow', GROUP);
    await idle();
    expect(await adapter.press(prompt, 'Deny', GROUP)).toEqual({
      notice: 'This request has expired',
    });
    expect(adapter.edited).toHaveLength(1);
  });

  it('ignores presses from a chat that is not allowed', async () => {
    const prompt = await askIn(OWNER);

    expect(await adapter.press(prompt, 'Allow', STRANGER)).toEqual({
      notice: "This chat isn't allowed to use Pero",
    });
    expect(adapter.edited).toEqual([]);

    await adapter.press(prompt, 'Deny', OWNER);
    await idle();
  });

  it('denies open requests when Pero stops', async () => {
    const prompt = await askIn(OWNER);

    await moduleRef.close();
    closed = true;

    expect(lastText()).toBe('echo: Hello (Bash denied: Pero is stopping)');
    expect(adapter.edited.at(-1)?.message.text).toBe(
      `${prompt.message.text}\n\nCancelled: Pero is stopping`,
    );
  });

  it('keeps tool requests out of the history', async () => {
    const prompt = await askIn(OWNER);
    await adapter.press(prompt, 'Allow', OWNER);
    await idle();

    const texts = (
      await moduleRef
        .get<DataSource>(getDataSourceToken())
        .getRepository(Message)
        .find({ order: { id: 'ASC' } })
    ).map((message) => message.text);
    expect(texts).not.toContain(prompt.message.text);
    expect(texts).toContain('echo: Hello (Bash allowed)');
  });
});
