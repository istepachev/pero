import {
  mkdirSync,
  mkdtempSync,
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
import { InvalidInputError } from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { Session } from '../src/persistence/entities/session.entity.js';
import type { RuntimeRequest } from '../src/runtimes/agent-runtime.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import { SettingsNotes } from '../src/settings-notes/settings-notes.service.js';
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

describe('Agents from notes (e2e)', () => {
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
    write('Pero.md', 'Be brief.');
    write('Agents/Groceries.md', '---\ntopics: Groceries\n---\nYou shop.');
    write('Agents/Pantry.md', '---\nmodel: haiku\n---\nYou stock up.');
    client = createControlClient(join(workspace, '.pero', 'run', 'pero.sock'));
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Writes `text` to the note at `file` in the settings folder. */
  function write(file: string, text: string) {
    const path = join(workspace, 'data', 'Settings', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
  }

  /** Writes a note and has Pero read it, as its next scan would. */
  async function edit(file: string, text: string) {
    write(file, text);
    await daemon!.app.get(SettingsNotes).rescan();
  }

  /** A daemon serving the forum group, whose Agents answer with an echo. */
  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ workspace, env: {} }),
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
    await client.call('settings.update', { telegramBotToken: TOKEN });
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

  /** Sends `text` in the topic and resolves to the Agent's answer. */
  async function say(text: string): Promise<string> {
    const before = api.sent().length;
    inTopic({ text });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(before + 1));
    return String(api.sent().at(-1)!.text);
  }

  /** The Groceries topic, onboarded with the Agent its note defines. */
  async function groceries() {
    await start();
    inTopic({
      text: undefined,
      forum_topic_created: { name: 'Groceries', icon_color: 0 },
    });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1));
    expect(String(api.sent()[0]!.text)).toMatch(
      /^This topic talks to Agent groceries: claude, default model/,
    );
  }

  it('applies edits to the body, model, effort, and Pero.md from the next turn of the same Session', async () => {
    await groceries();
    expect(await say('Milk')).toBe('echo: Milk');
    expect(lastRequest('claude')).toMatchObject({
      instructions: 'Be brief.\n\nYou shop.',
      providerOptions: { model: null, effort: null },
    });
    const [first] = await sessions();

    await edit(
      'Agents/Groceries.md',
      '---\ntopics: Groceries\nmodel: sonnet\neffort: high\n---\nYou shop cheaply.',
    );
    expect(await say('Eggs')).toBe('echo: Eggs');
    expect(lastRequest('claude')).toMatchObject({
      instructions: 'Be brief.\n\nYou shop cheaply.',
      providerOptions: { model: 'sonnet', effort: 'high' },
      providerSessionId: first!.providerSessionId,
    });

    // Pero.md changes every Agent that doesn't set the value itself.
    await edit(
      'Pero.md',
      '---\nclaude-model: opus\nclaude-effort: low\n---\nBe kind.',
    );
    expect(await say('Bread')).toBe('echo: Bread');
    expect(lastRequest('claude')).toMatchObject({
      instructions: 'Be kind.\n\nYou shop cheaply.',
      providerOptions: { model: 'sonnet', effort: 'high' },
      providerSessionId: first!.providerSessionId,
    });
    await expect(
      client.call('agents.get', { name: 'pantry' }),
    ).resolves.toMatchObject({
      model: 'haiku',
      effort: 'low',
      origins: { model: 'note', effort: 'pero' },
    });
    await edit('Agents/Groceries.md', '---\ntopics: Groceries\n---\nYou shop.');
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
      workingDirectory: join(workspace, 'data'),
    });

    await edit(
      'Agents/Groceries.md',
      '---\ntopics: Groceries\nprovider: codex\n---\nYou shop.',
    );
    const carried = await say('Eggs');
    expect(carried).toMatch(/^echo: \[Earlier conversation in this chat/);
    expect(carried).toMatch(/ User: Milk\n/);
    expect(carried).toMatch(/\n\nEggs$/);
    expect(await sessions()).toEqual([
      expect.objectContaining({ id: first!.id, status: 'closed' }),
      expect.objectContaining({ status: 'active', provider: 'codex' }),
    ]);

    await edit(
      'Agents/Groceries.md',
      '---\ntopics: Groceries\nprovider: codex\nworking-directory: other\n---\nYou shop.',
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

  it('refuses to change Agents and settings in the database, naming the note', async () => {
    await start();
    await expect(
      client.call('agents.create', { name: 'garden' }),
    ).rejects.toThrow(
      new InvalidInputError(
        'Agents are configured in notes now: add data/Settings/Agents/garden.md (Agents/_Template.md shows the properties).',
      ),
    );
    await expect(
      client.call('agents.edit', {
        name: 'pantry',
        change: { enabled: false },
      }),
    ).rejects.toThrow(
      new InvalidInputError(
        'Agents are configured in notes now: set enabled: false in data/Settings/Agents/Pantry.md.',
      ),
    );
    await expect(
      client.call('settings.update', {
        providerDefaults: { codex: { effort: 'high' } },
      }),
    ).rejects.toThrow(
      new InvalidInputError(
        'Settings are in notes now: set codex-effort in data/Settings/Pero.md.',
      ),
    );
    await expect(
      client.call('settings.update', { defaultWorkingDirectory: tmp }),
    ).rejects.toThrow(
      new InvalidInputError(
        'The data folder is set in config.yaml now: set data in .pero/config.yaml, then restart Pero.',
      ),
    );
  });
});
