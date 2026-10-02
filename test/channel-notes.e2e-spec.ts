import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentContext } from '../src/agents/agent-request.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { agentGuide, guideFile } from '../src/guide/agent-guide.js';
import { Session } from '../src/persistence/entities/session.entity.js';
import type { RuntimeRequest } from '../src/runtimes/agent-runtime.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import { BrokenNoteReports } from '../src/notifications/broken-note-reports.js';
import { SystemNotes } from '../src/system/system-notes.service.js';
import {
  FakeBotApi,
  type UpdateBody,
} from '../src/telegram/testing/fake-bot-api.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };
const TOPIC = 42;
/** The Groceries topic's `channel-id`. */
const GROCERIES = `telegram:${FORUM.id}:${TOPIC}`;

describe('Channel notes (e2e)', () => {
  let tmp: string;
  let workspace: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;
  let nextMessageId: number;
  /** Each edit gets a later modification time, whatever the clock. */
  let clock: number;

  beforeEach(async () => {
    api = new FakeBotApi();
    api.chats.set(String(FORUM.id), FORUM);
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    workspace = join(tmp, 'ws');
    initWorkspace(workspace, tmp);
    mkdirSync(join(workspace, 'other'));
    clock = Date.parse('2026-01-01T00:00:00Z');
    write('Persona.md', 'Be calm.');
    write('Instructions.md', 'Be brief.');
    write('Channels/Groceries.md', 'You shop.');
    write('Channels/Pantry.md', '---\nmodel: haiku\n---\nYou stock up.');
    client = createControlClient(join(workspace, '.pero', 'run', 'pero.sock'));
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Writes `text` to the note at `file` in the system folder. */
  function write(file: string, text: string) {
    const path = join(workspace, 'data', 'System', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
  }

  /** Writes a note and has Pero read it, as its next scan would. */
  async function edit(file: string, text: string) {
    write(file, text);
    await daemon!.app.get(SystemNotes).rescan();
  }

  /** A daemon serving the forum group, where Pero answers with an echo. */
  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ workspace, env: {} }),
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
    await client.call('telegram.token', { token: TOKEN });
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
  }

  function sessions(): Promise<Session[]> {
    return daemon!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(Session)
      .find({ order: { id: 'ASC' } });
  }

  function lastRequest(provider: 'claude' | 'codex'): RuntimeRequest {
    const runtime = daemon!.app
      .get(AgentRuntimes)
      .get(provider) as FakeAgentRuntime;
    return runtime.requests.at(-1)!;
  }

  function inTopic(fields: Partial<Message>): number {
    return api.push({
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat: FORUM,
        from: OWNER,
        message_thread_id: TOPIC,
        is_topic_message: true,
        ...fields,
      } as never,
    } satisfies UpdateBody);
  }

  /** Sends `text` in the topic and resolves to Pero's answer. */
  async function say(text: string): Promise<string> {
    const before = api.sent().length;
    inTopic({ text });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(before + 1));
    return String(api.sent().at(-1)!.text);
  }

  /** What the instructions of a turn with `Channels/<title>.md` start with. */
  function context(title: string): string {
    return agentContext(
      { title, file: `Channels/${title}.md` },
      {
        dataFolder: join(workspace, 'data'),
        systemFolder: join(workspace, 'data', 'System'),
        guideFile: guideFile(workspace),
      },
    );
  }

  /**
   * The Groceries topic, onboarded with `Channels/Groceries.md`, which Pero
   * binds to it by title.
   */
  async function groceries() {
    await start();
    inTopic({
      text: undefined,
      forum_topic_created: { name: 'Groceries', icon_color: 0 },
    });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1));
    expect(String(api.sent()[0]!.text)).toMatch(
      /^Pero answers in this topic with claude, default model, .*data\/System\/Channels\/Groceries\.md/s,
    );
    expect(
      readFileSync(
        join(workspace, 'data', 'System', 'Channels', 'Groceries.md'),
        'utf8',
      ),
    ).toBe(`---\nchannel-id: ${GROCERIES}\n---\nYou shop.`);
  }

  /** The ID of the Groceries topic's Channel. */
  async function groceriesId(): Promise<number> {
    const { channels } = await client.call('channels.list');
    return channels.find(({ title }) => title === 'Groceries')!.id;
  }

  it('applies edits to the body, model, effort, Pero.md, Persona.md, and Instructions.md from the next turn of the same Session', async () => {
    await groceries();
    // The guide the instructions point to is written at startup.
    expect(readFileSync(guideFile(workspace), 'utf8')).toBe(agentGuide());
    expect(await say('Milk')).toBe('echo: Milk');
    expect(lastRequest('claude')).toMatchObject({
      instructions: `${context('Groceries')}\n\nBe calm.\n\nBe brief.\n\nYou shop.`,
      providerOptions: { model: null, effort: null },
    });
    const [first] = await sessions();
    expect(first).toMatchObject({ agentName: 'groceries' });

    await edit(
      'Channels/Groceries.md',
      `---\nchannel-id: ${GROCERIES}\nmodel: sonnet\neffort: high\n---\nYou shop cheaply.`,
    );
    expect(await say('Eggs')).toBe('echo: Eggs');
    expect(lastRequest('claude')).toMatchObject({
      instructions: `${context('Groceries')}\n\nBe calm.\n\nBe brief.\n\nYou shop cheaply.`,
      providerOptions: { model: 'sonnet', effort: 'high' },
      providerSessionId: first!.providerSessionId,
    });

    // Pero.md changes every Channel note that doesn't set the value itself,
    // and Persona.md and Instructions.md start every Channel's instructions.
    await edit('Pero.md', '---\nclaude-model: opus\nclaude-effort: low\n---');
    await edit('Persona.md', 'Be kind.');
    await edit('Instructions.md', '');
    expect(await say('Bread')).toBe('echo: Bread');
    expect(lastRequest('claude')).toMatchObject({
      instructions: `${context('Groceries')}\n\nBe kind.\n\nYou shop cheaply.`,
      providerOptions: { model: 'sonnet', effort: 'high' },
      providerSessionId: first!.providerSessionId,
    });
    await edit(
      'Channels/Groceries.md',
      `---\nchannel-id: ${GROCERIES}\nmodel: haiku\n---\nYou shop.`,
    );
    await expect(
      client.call('channels.get', { id: await groceriesId() }),
    ).resolves.toMatchObject({
      settings: {
        name: 'groceries',
        model: 'haiku',
        effort: 'low',
        origins: { model: 'note', effort: 'pero' },
      },
    });
    await edit(
      'Channels/Groceries.md',
      `---\nchannel-id: ${GROCERIES}\n---\nYou shop.`,
    );
    expect(await say('Tea')).toBe('echo: Tea');
    expect(lastRequest('claude')).toMatchObject({
      providerOptions: { model: 'opus', effort: 'low' },
    });
    expect(await sessions()).toEqual([
      expect.objectContaining({ id: first!.id, status: 'active' }),
    ]);
  });

  it('starts a fresh Session with recent messages after a provider or folder edit', async () => {
    await groceries();
    expect(await say('Milk')).toBe('echo: Milk');
    const [first] = await sessions();
    expect(first).toMatchObject({
      provider: 'claude',
      workingDirectory: workspace,
    });

    await edit(
      'Channels/Groceries.md',
      `---\nchannel-id: ${GROCERIES}\nprovider: codex\n---\nYou shop.`,
    );
    const carried = await say('Eggs');
    expect(carried).toMatch(/^echo: \[Earlier conversation in this chat/);
    expect(carried).toMatch(/ User: Milk\n.* Pero: echo: Milk\n/s);
    expect(carried).toMatch(/\n\nEggs$/);
    expect(await sessions()).toEqual([
      expect.objectContaining({ id: first!.id, status: 'closed' }),
      expect.objectContaining({ status: 'active', provider: 'codex' }),
    ]);

    await edit(
      'Channels/Groceries.md',
      `---\nchannel-id: ${GROCERIES}\nprovider: codex\nworking-directory: other\n---\nYou shop.`,
    );
    expect(await say('Butter')).toMatch(
      /^echo: \[Earlier conversation.*User: Eggs.*\n\nButter$/s,
    );
    expect(lastRequest('codex').workingDirectory).toBe(
      join(workspace, 'other'),
    );
    expect((await sessions()).at(-1)).toMatchObject({
      status: 'active',
      provider: 'codex',
      workingDirectory: join(workspace, 'other'),
    });
  });

  it('answers a topic with the note its channel-id moves to from its next message, in the same Session', async () => {
    await groceries();
    expect(await say('Milk')).toBe('echo: Milk');
    const [first] = await sessions();

    // Bound twice: Pero reports both notes in the topic, neither
    // answers, and Pero says why once.
    await edit(
      'Channels/Pantry.md',
      `---\nchannel-id: ${GROCERIES}\nmodel: haiku\n---\nYou stock up.`,
    );
    await daemon!.app.get(BrokenNoteReports).idle();
    expect(api.sent().at(-1)).toMatchObject({
      message_thread_id: TOPIC,
      text: [
        'Errors in data/System/Channels/Groceries.md:',
        `channel-id: ${GROCERIES} is also the channel-id of Channels/Pantry.md; keep it in only one of them`,
        "It's left out until it's fixed.",
        '',
        'Errors in data/System/Channels/Pantry.md:',
        `channel-id: ${GROCERIES} is also the channel-id of Channels/Groceries.md; keep it in only one of them`,
        "It's left out until it's fixed.",
      ].join('\n'),
    });
    expect(await say('Eggs')).toBe(
      "Pero doesn't answer here yet: data/System/Channels/Groceries.md and " +
        "data/System/Channels/Pantry.md are this Channel's note but have " +
        "errors, so they haven't loaded. Run pero check on the Pero host to " +
        'see them.',
    );
    const told = api.sent().length;
    const update = inTopic({ text: 'Anyone?' });
    await vi.waitFor(() =>
      expect(
        api
          .callsOf('getUpdates')
          .some((call) => Number(call.payload.offset) > update),
      ).toBe(true),
    );
    expect(api.sent()).toHaveLength(told);

    await edit('Channels/Groceries.md', 'You shop.');
    expect(await say('Bread')).toBe('echo: Bread');
    expect(lastRequest('claude')).toMatchObject({
      instructions: `${context('Pantry')}\n\nBe calm.\n\nBe brief.\n\nYou stock up.`,
      providerOptions: { model: 'haiku' },
      providerSessionId: first!.providerSessionId,
    });
    expect(await sessions()).toEqual([
      expect.objectContaining({
        id: first!.id,
        agentName: 'groceries',
        status: 'active',
      }),
    ]);
    expect(await client.call('channels.list')).toEqual({
      channels: [
        expect.objectContaining({
          title: 'Groceries',
          note: 'data/System/Channels/Pantry.md',
          unanswered: null,
        }),
      ],
      unusedNotes: [
        { file: 'data/System/Channels/Groceries.md', channelId: null },
      ],
    });
  });
});
