import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChannelTurns } from '../channels/agent-channel-turns.js';
import type { InboundChat } from '../channels/channel-adapter.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { ChannelTurns } from '../channels/channel-stages.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  privateChat,
  topicCreated,
} from '../channels/testing/fake-channel-adapter.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { ComponentHealth } from '../health/component-health.js';
import { type AgentRuntime, RuntimeError } from '../runtimes/agent-runtime.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { TestWorkspace } from '../settings/testing/test-workspace.js';
import { AgentManager, type IsolatedTurn, TurnError } from './agent-manager.js';
import { AgentsModule } from './agents.module.js';

const GROUP = groupChat('-1009007199254740993', 'Household');
const OWNER = privateChat('1234');

describe('AgentManager', () => {
  let ws: TestWorkspace;
  let workspace: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let adapter: FakeChannelAdapter;
  let claude: FakeAgentRuntime;
  let codex: FakeAgentRuntime;

  /** Starts Pero's Channel and Agent services on the test database. */
  async function boot(runtimes: AgentRuntime[] = [claude, codex]) {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        AgentsModule,
        ChannelsModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue(runtimes)
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    ws.use(moduleRef);
    const allowedChats = moduleRef.get(AllowedChatsService);
    for (const chat of [GROUP, OWNER]) {
      if ((await allowedChats.find('telegram', chat.key)) !== null) continue;
      await allowedChats.allow({
        integrationKind: 'telegram',
        chatKey: chat.key,
        kind: chat.kind,
        title: chat.title,
      });
    }
    adapter = new FakeChannelAdapter();
    await moduleRef.get(ChannelRouter).connect(adapter);
  }

  async function restart(runtimes?: AgentRuntime[]) {
    await moduleRef.close();
    await boot(runtimes);
  }

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-agent-manager-');
    workspace = ws.root;
    await ws.pero();
    await ws.agent('Main');
    claude = new FakeAgentRuntime('claude');
    codex = new FakeAgentRuntime('codex');
    await boot();
  });

  afterEach(async () => {
    await moduleRef.close();
    vi.restoreAllMocks();
    ws.delete();
  });

  /** Settles once every accepted turn has answered. */
  function idle(): Promise<void> {
    return (moduleRef.get(ChannelTurns) as AgentChannelTurns).idle();
  }

  /** Sends `text` in `chat`, in `topic` when given, and waits for replies. */
  async function say(
    chat: InboundChat,
    text: string,
    topic?: string,
  ): Promise<void> {
    await adapter.deliver(inboundMessage(chat, { topic, text }));
    await idle();
  }

  function sentTexts(): string[] {
    return adapter.sent.map((sent) => sent.message.text);
  }

  function allMessages(): Promise<Message[]> {
    return ds.getRepository(Message).find({ order: { id: 'ASC' } });
  }

  function allSessions(): Promise<Session[]> {
    return ds.getRepository(Session).find({ order: { id: 'ASC' } });
  }

  async function channelFor(key: string): Promise<Channel> {
    return ds
      .getRepository(Channel)
      .findOneByOrFail({ integrationKind: 'telegram', externalKey: key });
  }

  /** Lets queued promise callbacks and database work run. */
  function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("answers in the Channel with the Agent's reply", async () => {
    await say(OWNER, 'Hello');

    expect(adapter.sent.at(-1)).toEqual({
      address: OWNER.address,
      message: { text: 'echo: Hello' },
    });
  });

  it('runs turns within a Session one at a time, in order', async () => {
    await adapter.emit(topicCreated(GROUP, '7', { title: 'Groceries' }));
    const first = claude.hold();

    await adapter.deliver(inboundMessage(GROUP, { topic: '7', text: 'one' }));
    await first.started;
    await adapter.deliver(inboundMessage(GROUP, { topic: '7', text: 'two' }));
    await tick();

    expect(claude.requests.map((request) => request.input)).toEqual(['one']);

    first.release();
    await idle();

    expect(claude.requests.map((request) => request.input)).toEqual([
      'one',
      'two',
    ]);
    expect(claude.requests[1]!.providerSessionId).toBe('fake-claude-1');
    expect(sentTexts().slice(-2)).toEqual(['echo: one', 'echo: two']);
  });

  it('runs turns of different Agents in the same folder in parallel', async () => {
    await adapter.emit(topicCreated(GROUP, '7', { title: 'Groceries' }));
    await adapter.emit(topicCreated(GROUP, '8', { title: 'Health' }));
    const groceries = claude.hold();
    const health = claude.hold();

    await adapter.deliver(inboundMessage(GROUP, { topic: '7', text: 'milk' }));
    await adapter.deliver(inboundMessage(GROUP, { topic: '8', text: 'run' }));
    // Both are running at once; either would hang here otherwise.
    const started = await Promise.all([groceries.started, health.started]);

    expect(started.map((request) => request.workingDirectory)).toEqual([
      workspace,
      workspace,
    ]);
    expect(
      new Set((await allSessions()).map((session) => session.agentName)).size,
    ).toBe(2);
    groceries.release();
    health.release();
    await idle();
    expect(sentTexts()).toContain('echo: milk');
    expect(sentTexts()).toContain('echo: run');
  });

  it("builds the request from the Agent's resolved settings", async () => {
    await say(OWNER, 'Hello');
    await ws.editAgent(
      'Main',
      { model: 'claude-opus-5-5', effort: 'high' },
      'Be brief.',
    );

    await say(OWNER, 'Again');

    expect(claude.requests[0]).not.toHaveProperty('providerSessionId');
    expect(claude.requests[1]).toMatchObject({
      input: 'Again',
      // The main Agent's own instructions, which it doesn't repeat.
      instructions: `${ws.agentContext('Main')}\n\nBe brief.`,
      providerOptions: { model: 'claude-opus-5-5', effort: 'high' },
      workingDirectory: workspace,
      skipGitRepoCheck: false,
      toolPolicy: { permissions: 'ask' },
    });
    expect(claude.requests[1]!.signal).toBeInstanceOf(AbortSignal);
  });

  describe('Session policy', () => {
    beforeEach(async () => {
      await say(OWNER, 'Hello');
    });

    async function expectFreshSession(runtime: FakeAgentRuntime) {
      const request = runtime.requests.at(-1)!;
      expect(request).not.toHaveProperty('providerSessionId');
      const sessions = await allSessions();
      expect(sessions.map((session) => session.status)).toEqual([
        'closed',
        'active',
      ]);
      return { request, session: sessions[1]! };
    }

    it('starts a fresh Session when the provider changes', async () => {
      await ws.editAgent('Main', { provider: 'codex' });

      await say(OWNER, 'Again');

      const { request, session } = await expectFreshSession(codex);
      expect(session).toMatchObject({
        provider: 'codex',
        providerSessionId: 'fake-codex-1',
      });
      expect(request.input).toMatch(/\n\nAgain$/);
      expect(sentTexts().at(-1)).toBe(`echo: ${request.input}`);
    });

    it('keeps the Session when the data folder moves, naming the new one', async () => {
      // A new data folder applies on restart; the notes stay where they are.
      const other = join(ws.root, 'other');
      mkdirSync(other);
      writeFileSync(
        join(ws.stateFolder, 'config.yaml'),
        'data: other\nsettings: data/Settings\n',
      );
      await restart();

      await say(OWNER, 'Again');

      const request = claude.requests.at(-1)!;
      expect(request.providerSessionId).toBe('fake-claude-1');
      expect(request.workingDirectory).toBe(workspace);
      expect(request.instructions).toBe(ws.agentContext('Main', other));
    });

    it('starts a fresh Session when the Agent gets its own folder', async () => {
      const own = join(ws.root, 'own');
      mkdirSync(own);
      await ws.editAgent('Main', { 'working-directory': own });

      await say(OWNER, 'Again');

      const { request } = await expectFreshSession(claude);
      expect(request.workingDirectory).toBe(own);
    });

    it('resumes the same Session when the model or effort changes', async () => {
      await ws.editAgent('Main', { model: 'claude-sonnet-5', effort: 'low' });

      await say(OWNER, 'Again');

      expect(claude.requests[1]).toMatchObject({
        providerSessionId: 'fake-claude-1',
        providerOptions: { model: 'claude-sonnet-5', effort: 'low' },
        input: 'Again',
      });
      expect(await allSessions()).toHaveLength(1);
    });

    it('resumes the provider session after a restart', async () => {
      await restart();

      await say(OWNER, 'Again');

      expect(claude.requests[1]!.providerSessionId).toBe('fake-claude-1');
      expect(await allSessions()).toHaveLength(1);
    });
  });

  it('keeps separate Sessions for a General topic and a direct chat of the main Agent', async () => {
    await say(GROUP, 'From the group');
    await say(OWNER, 'From the chat');
    await say(GROUP, 'Group again');

    const general = await channelFor(GROUP.key);
    const direct = await channelFor(OWNER.key);
    const sessions = await allSessions();
    expect(
      sessions.map(({ channelId, agentName, providerSessionId }) => ({
        channelId,
        agentName,
        providerSessionId,
      })),
    ).toEqual([
      {
        channelId: general.id,
        agentName: 'main',
        providerSessionId: 'fake-claude-1',
      },
      {
        channelId: direct.id,
        agentName: 'main',
        providerSessionId: 'fake-claude-2',
      },
    ]);
    expect(claude.requests[2]!.providerSessionId).toBe('fake-claude-1');
  });

  it('posts a failure notice and still runs the next turn', async () => {
    claude.failNext();

    await say(OWNER, 'Hello');
    await say(OWNER, 'Again');

    expect(sentTexts().slice(-2)).toEqual([
      "Agent main couldn't answer: The model is overloaded.",
      'echo: Again',
    ]);
    // The session was reported before the failure, so it carries on.
    expect(claude.requests[1]!.providerSessionId).toBe('fake-claude-1');
  });

  describe('when the provider no longer has the conversation', () => {
    const lost = () =>
      new RuntimeError(
        'session_lost',
        'No conversation found with session ID: fake-claude-1',
      );

    it('answers the same turn in a fresh Session that carries over the history', async () => {
      await say(OWNER, 'one');
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      claude.failNext(lost());

      await say(OWNER, 'two');

      expect(claude.requests.map((r) => r.providerSessionId)).toEqual([
        undefined,
        'fake-claude-1',
        undefined,
      ]);
      const retried = claude.requests[2]!.input;
      expect(retried).toMatch(
        /^\[Earlier conversation in this chat, from a previous session\]\n.*User: one\n.*main: echo: one\n\[End of earlier conversation\]\n\ntwo$/s,
      );
      expect(sentTexts().at(-1)).toBe(`echo: ${retried}`);
      const [old, fresh] = await allSessions();
      expect(old).toMatchObject({ status: 'closed' });
      expect(fresh).toMatchObject({
        status: 'active',
        providerSessionId: 'fake-claude-2',
      });
      // The message and its answer belong to the fresh Session.
      expect(
        (await allMessages()).slice(-2).map((m) => [m.text, m.sessionId]),
      ).toEqual([
        ['two', fresh!.id],
        [`echo: ${retried}`, fresh!.id],
      ]);

      await say(OWNER, 'three');
      expect(claude.requests.at(-1)).toMatchObject({
        input: 'three',
        providerSessionId: 'fake-claude-2',
      });
    });

    it('fails a turn that resumed nothing, without trying again', async () => {
      claude.failNext(lost());

      await say(OWNER, 'Hello');

      expect(claude.requests).toHaveLength(1);
      expect(sentTexts().at(-1)).toBe(
        "Agent main couldn't answer: No conversation found with session ID: fake-claude-1.",
      );
    });
  });

  it('reports the provider degraded when a turn is refused as signed out, and ok once one succeeds', async () => {
    const health = moduleRef.get(ComponentHealth);
    claude.failNext(
      new RuntimeError('auth', 'Not logged in · Please run /login'),
    );

    await say(OWNER, 'Hello');

    expect(sentTexts().at(-1)).toMatch(/the provider is signed out/);
    expect(health.get('claude')).toMatchObject({
      state: 'degraded',
      detail: expect.stringContaining('claude auth login'),
    });

    await say(OWNER, 'Again');

    expect(health.get('claude')).toMatchObject({
      state: 'ok',
      detail: 'Signed in',
    });
  });

  it("passes the turn's approver to the runtime", async () => {
    await say(OWNER, 'Hello');
    const channel = await channelFor(OWNER.key);
    const [message] = await allMessages();
    const approve = vi.fn();

    await moduleRef.get(AgentManager).runTurn({
      channelId: channel.id,
      agent: 'main',
      messageId: message!.id,
      input: 'Again',
      approve,
    });

    // A turn from the Channel asks there; this one asks `approve`.
    expect(claude.requests[0]!.approve).toBeTypeOf('function');
    expect(claude.requests[1]!.approve).toBe(approve);
  });

  it("passes the workspace's settings folder and guide to the runtime, in Channels and Workflow runs", async () => {
    const { settingsFolder } = ws;
    const guide = join(ws.stateFolder, 'guide.md');
    await say(OWNER, 'Hello');
    await say(OWNER, 'Again');
    await moduleRef.get(AgentManager).runIsolated({
      agent: 'main',
      provider: 'claude',
      request: {
        providerOptions: { model: null, effort: null },
        workingDirectory: workspace,
        instructions: '',
        toolPolicy: { permissions: 'ask' },
        skipGitRepoCheck: false,
      },
      input: 'Work',
      label: 'test',
    });

    expect(claude.requests[0]!.settingsFolder).toBe(settingsFolder);
    expect(claude.requests[1]!.settingsFolder).toBe(settingsFolder);
    expect(claude.requests[2]!.settingsFolder).toBe(settingsFolder);
    expect(claude.requests.map((request) => request.guideFile)).toEqual([
      guide,
      guide,
      guide,
    ]);
    expect(claude.requests[2]).not.toHaveProperty('approve');
  });

  it("tells the Channel when the Agent's provider has no runtime yet", async () => {
    await restart([codex]);

    await say(OWNER, 'Hello');

    expect(sentTexts().at(-1)).toBe(
      "Agent main couldn't answer: the claude runtime isn't available yet.",
    );
  });

  it('skips a turn whose Agent was disabled after it was accepted', async () => {
    await say(OWNER, 'Hello');
    const held = claude.hold();
    await adapter.deliver(inboundMessage(OWNER, { text: 'one' }));
    await held.started;
    await adapter.deliver(inboundMessage(OWNER, { text: 'two' }));
    await ws.editAgent('Main', { enabled: false });

    held.release();
    await idle();

    expect(claude.requests.map((request) => request.input)).toEqual([
      'Hello',
      'one',
    ]);
    expect(sentTexts().at(-1)).toBe('echo: one');
    // Received, so in the history, but never part of a Session.
    expect(
      (await allMessages()).find((message) => message.text === 'two'),
    ).toMatchObject({ direction: 'in', sessionId: null });
  });

  it('skips a turn whose Channel went to another Agent after it was accepted', async () => {
    await say(OWNER, 'Hello');
    const channel = await channelFor(OWNER.key);
    await ws.agent('Other');
    const held = claude.hold();
    await adapter.deliver(inboundMessage(OWNER, { text: 'one' }));
    await held.started;
    await adapter.deliver(inboundMessage(OWNER, { text: 'two' }));
    await ws.editPero({ 'main-agent': 'Other' });

    held.release();
    await idle();

    expect(claude.requests.map((request) => request.input)).toEqual([
      'Hello',
      'one',
    ]);

    // The new Agent starts fresh, with the skipped message carried over,
    // and the old Agent's Session ends.
    await say(OWNER, 'three');
    expect(claude.requests.at(-1)!.input).toMatch(/User: two\n.*\n\nthree$/s);
    expect(
      (await allSessions()).filter((session) => session.status === 'active'),
    ).toEqual([
      expect.objectContaining({ channelId: channel.id, agentName: 'other' }),
    ]);
  });

  it('starts afresh when a Channel goes back to an Agent it had before', async () => {
    await say(OWNER, 'Hello');
    await ws.agent('Other');

    await ws.editPero({ 'main-agent': 'Other' });
    await say(OWNER, 'to other');
    await ws.editPero({ 'main-agent': null });
    await say(OWNER, 'back');

    // Main's first Session ended; its return starts a new one.
    expect(claude.requests.at(-1)!.providerSessionId).toBeUndefined();
    expect(claude.requests.at(-1)!.input).toMatch(
      /User: to other\n.*\n\nback$/s,
    );
    expect(
      (await allSessions()).map(({ agentName, status }) => ({
        agentName,
        status,
      })),
    ).toEqual([
      { agentName: 'main', status: 'closed' },
      { agentName: 'other', status: 'closed' },
      { agentName: 'main', status: 'active' },
    ]);
  });

  describe('message history', () => {
    /** The transcript lines of `input`, without their times. */
    function transcript(input: string): string[] {
      return input
        .split('\n')
        .map((line) => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d /, ''));
    }

    it('records each message and reply once, with its Channel, Agent, and Session', async () => {
      await say(OWNER, 'Hello');

      const direct = await channelFor(OWNER.key);
      const [session] = await allSessions();
      const entry = {
        channelId: direct.id,
        agentName: 'main',
        sessionId: session!.id,
      };
      expect(await allMessages()).toEqual([
        expect.objectContaining({
          channelId: direct.id,
          agentName: null,
          sessionId: null,
          origin: 'pero',
          text: expect.stringMatching(/^This chat talks to Agent main/),
        }),
        expect.objectContaining({
          ...entry,
          direction: 'in',
          origin: 'user',
          senderId: '42',
          text: 'Hello',
        }),
        expect.objectContaining({
          ...entry,
          direction: 'out',
          origin: 'agent',
          externalMessageId: '2',
          senderId: null,
          text: 'echo: Hello',
        }),
      ]);
    });

    it("records a failure notice as Pero's", async () => {
      claude.failNext();

      await say(OWNER, 'Hello');

      expect((await allMessages()).at(-1)).toMatchObject({
        direction: 'out',
        origin: 'pero',
        agentName: null,
        sessionId: null,
        text: "Agent main couldn't answer: The model is overloaded.",
      });
    });

    it('records nothing that could not be sent', async () => {
      await say(OWNER, 'Hello');
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      adapter.failSends = true;

      await say(OWNER, 'Again');

      expect((await allMessages()).map((message) => message.text)).toEqual([
        expect.stringMatching(/^This chat talks to Agent main/),
        'Hello',
        'echo: Hello',
        'Again',
      ]);
    });

    it("starts a new Channel's first Session with nothing carried over", async () => {
      await say(OWNER, 'Hello');

      expect(claude.requests[0]!.input).toBe('Hello');
    });

    it('carries the latest messages into the first turn after a provider change, and none after', async () => {
      await ws.pero({ 'history-carryover': 3 });
      await say(OWNER, 'one');
      await say(OWNER, 'two');
      await ws.editAgent('Main', { provider: 'codex' });

      await say(OWNER, 'three');
      await say(OWNER, 'four');

      expect(transcript(codex.requests[0]!.input)).toEqual([
        '[Earlier conversation in this chat, from a previous session]',
        'main: echo: one',
        'User: two',
        'main: echo: two',
        '[End of earlier conversation]',
        '',
        'three',
      ]);
      expect(codex.requests[1]!.input).toBe('four');
      // The history keeps what was said, not what the provider was sent.
      expect((await allMessages()).map((message) => message.text)).toContain(
        'three',
      );
    });

    it('carries over when the Agent moves to another folder', async () => {
      await say(OWNER, 'one');
      const own = join(ws.root, 'own');
      mkdirSync(own);
      await ws.editAgent('Main', { 'working-directory': own });

      await say(OWNER, 'two');

      expect(transcript(claude.requests[1]!.input)).toEqual([
        '[Earlier conversation in this chat, from a previous session]',
        'User: one',
        'main: echo: one',
        '[End of earlier conversation]',
        '',
        'two',
      ]);
    });

    it("carries only the Channel's own messages", async () => {
      await say(GROUP, 'In the group');
      await say(OWNER, 'In the chat');
      await ws.editAgent('Main', { provider: 'codex' });

      await say(OWNER, 'Again');

      const lines = transcript(codex.requests[0]!.input);
      expect(lines).toContain('User: In the chat');
      expect(lines.join('\n')).not.toContain('In the group');
    });

    it('carries nothing when history-carryover is 0', async () => {
      await say(OWNER, 'one');
      await ws.pero({ 'history-carryover': 0 });
      await ws.editAgent('Main', { provider: 'codex' });

      await say(OWNER, 'two');

      expect(codex.requests[0]!.input).toBe('two');
    });
  });

  describe('isolated turns', () => {
    function isolated(signal: AbortSignal) {
      const turn: IsolatedTurn = {
        agent: 'main',
        provider: 'claude',
        request: {
          providerOptions: { model: null, effort: null },
          workingDirectory: workspace,
          instructions: '',
          toolPolicy: { permissions: 'ask' },
          skipGitRepoCheck: false,
        },
        input: 'Work',
        label: 'test',
        signal,
      };
      return moduleRef.get(AgentManager).runIsolated(turn);
    }

    it('aborts the turn when its signal does', async () => {
      const held = claude.hold();
      const controller = new AbortController();
      const result = isolated(controller.signal);
      const request = await held.started;

      controller.abort();

      await expect(result).rejects.toThrow(TurnError);
      expect(request.signal.aborted).toBe(true);
    });

    it('aborts a turn whose signal aborted before it started', async () => {
      const held = claude.hold();
      const controller = new AbortController();
      controller.abort();

      await expect(isolated(controller.signal)).rejects.toThrow(TurnError);
      expect((await held.started).signal.aborted).toBe(true);
    });
  });

  describe('on shutdown', () => {
    it('aborts running turns after the timeout and drops queued ones', async () => {
      await say(OWNER, 'Hello');
      const held = claude.hold();
      await adapter.deliver(inboundMessage(OWNER, { text: 'one' }));
      const request = await held.started;
      await adapter.deliver(inboundMessage(OWNER, { text: 'two' }));

      await moduleRef.get(AgentManager).drain(10);
      await idle();

      expect(request.signal.aborted).toBe(true);
      expect(claude.requests).toHaveLength(2);
      const stopped =
        'Pero stopped before Agent main answered. ' +
        'Send the message again once Pero is back.';
      expect(sentTexts().slice(-2)).toEqual([stopped, stopped]);
      // The provider session survives for the next start.
      expect((await allSessions())[0]!.providerSessionId).toBe('fake-claude-1');
    });

    it('lets a running turn finish within the timeout', async () => {
      const held = claude.hold();
      await adapter.deliver(inboundMessage(OWNER, { text: 'one' }));
      const request = await held.started;

      const drained = moduleRef.get(AgentManager).drain(10_000);
      held.release();
      await drained;
      await idle();

      expect(request.signal.aborted).toBe(false);
      expect(sentTexts().at(-1)).toBe('echo: one');
    });

    it('refuses turns once draining', async () => {
      await moduleRef.get(AgentManager).drain(10);

      await say(OWNER, 'Hello');

      expect(claude.requests).toHaveLength(0);
      expect(sentTexts().at(-1)).toMatch(/^Pero stopped before Agent main/);
    });
  });
});
