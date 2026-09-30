import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { LegacyChannelAgent } from '../src/persistence/entities/legacy-channel-agent.entity.js';
import { Session } from '../src/persistence/entities/session.entity.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import {
  FakeBotApi,
  type UpdateBody,
} from '../src/telegram/testing/fake-bot-api.js';

/*
 * `pero migrate` on an installation in use: a legacy data directory with
 * Agents, topics, a Workflow with two schedules, and Sessions becomes a
 * workspace whose notes pass `pero check`, and whose Pero carries on.
 */

// `npm run test:e2e` builds first.
const PERO = join(import.meta.dirname, '../bin/pero.js');

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const DIRECT: Chat.PrivateChat = {
  id: 1234,
  type: 'private',
  first_name: 'Ada',
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };
const ENGLISH = 42;
const KITCHEN = 43;

describe('pero migrate (e2e)', () => {
  let tmp: string;
  let vault: string;
  let legacy: string;
  let workspace: string;
  let daemon: Daemon | undefined;
  let client: ControlClient;
  let api: FakeBotApi;
  let nextMessageId: number;

  beforeEach(async () => {
    api = new FakeBotApi();
    api.chats.set(String(FORUM.id), FORUM);
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    vault = join(tmp, 'vault');
    legacy = join(tmp, 'pero');
    workspace = join(tmp, 'ws');
    mkdirSync(vault);
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function start(config: ReturnType<typeof resolveBootstrapConfig>) {
    daemon = await startDaemon({
      config,
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
    client = createControlClient(join(config.dataDir, 'run', 'pero.sock'));
  }

  async function connected() {
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
  }

  async function stop() {
    await daemon!.stop('migrating');
    daemon = undefined;
  }

  function sessions(): Promise<Session[]> {
    return daemon!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(Session)
      .find({ order: { id: 'ASC' } });
  }

  function send(chat: Chat, topic: number | null, fields: Partial<Message>) {
    api.push({
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat,
        from: OWNER,
        ...(topic === null
          ? {}
          : { message_thread_id: topic, is_topic_message: true }),
        ...fields,
      } as never,
    } satisfies UpdateBody);
  }

  async function say(chat: Chat, topic: number | null, text: string) {
    const before = api.sent().length;
    send(chat, topic, { text });
    await vi.waitFor(() =>
      expect(
        api
          .sent()
          .slice(before)
          .filter(
            (payload) =>
              String(payload.chat_id) === String(chat.id) &&
              payload.message_thread_id === (topic ?? undefined) &&
              String(payload.text).startsWith('echo: '),
          ),
      ).toHaveLength(1),
    );
  }

  async function createTopic(topic: number, name: string) {
    send(FORUM, topic, { forum_topic_created: { name, icon_color: 0 } });
    await vi.waitFor(async () =>
      expect(
        (await client.call('channels.list')).channels.map((c) => c.key),
      ).toContain(`${FORUM.id}:${topic}`),
    );
  }

  async function channelId(topic: number): Promise<number> {
    const { channels } = await client.call('channels.list');
    return channels.find((channel) => channel.key === `${FORUM.id}:${topic}`)!
      .id;
  }

  function pero(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const {
      PERO_HOME: _home,
      PERO_WORKSPACE: _workspace,
      PERO_TELEGRAM_BOT_TOKEN: _token,
      ...env
    } = process.env;
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [PERO, ...args],
        { env: { ...env, HOME: tmp }, cwd: tmp },
        (error, stdout, stderr) =>
          resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
      );
    });
  }

  /** Every file under `dir` with its contents' hash and mode. */
  function tree(dir: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(dir, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      files[path.slice(dir.length)] =
        `${statSync(path).mode.toString(8)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
    return files;
  }

  it('turns an installation in use into a workspace that carries on', async () => {
    await start(resolveBootstrapConfig({ dataDir: legacy, env: {} }));
    await client.call('settings.update', {
      defaultWorkingDirectory: vault,
      telegramBotToken: TOKEN,
      timezone: 'Europe/Lisbon',
    });
    await connected();
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
    await client.call('telegram.allow', { chatId: String(DIRECT.id) });
    await createTopic(ENGLISH, 'English');
    await createTopic(KITCHEN, 'Kitchen');
    await client.call('agents.create', { name: 'coder', provider: 'codex' });
    // Where a 0.1 installation's pero channels assign put it.
    await daemon!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(LegacyChannelAgent)
      .update(await channelId(KITCHEN), { agentName: 'coder' });
    for (const [chat, topic] of [
      [FORUM, ENGLISH],
      [FORUM, KITCHEN],
      [FORUM, null],
      [DIRECT, null],
    ] as const) {
      await say(chat, topic, 'Hello');
    }
    await client.call('workflows.create', {
      name: 'english',
      title: 'English review',
      agent: 'english',
      inputTemplate: 'Suggest better English.',
    });
    for (const cron of ['0 21 * * *', '30 7 * * 1-5']) {
      await client.call('triggers.add', {
        workflow: 'english',
        kind: 'schedule',
        cron,
      });
    }
    await client.call('workflows.notify', {
      name: 'english',
      channel: await channelId(ENGLISH),
      notify: true,
    });
    const recorded = await sessions();
    expect(recorded).toHaveLength(4);

    expect(await pero(['--data-dir', legacy, 'migrate', workspace])).toEqual({
      code: 1,
      stdout: '',
      stderr: `Pero is running for data directory ${legacy} — stop it with pero stop before migrating\n`,
    });
    await stop();

    const before = tree(legacy);
    const migrated = await pero(['--data-dir', legacy, 'migrate', workspace]);
    expect(migrated.stderr).toBe('');
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toBe(
      [
        `Migrated data directory ${legacy} into workspace ${workspace}:`,
        '  created  .pero/config.yaml',
        `  created  ${vault}/Settings/Pero.md`,
        `  created  ${vault}/Settings/Agents/coder.md`,
        `  created  ${vault}/Settings/Agents/English.md`,
        `  created  ${vault}/Settings/Agents/Kitchen.md`,
        `  created  ${vault}/Settings/Agents/main.md`,
        // "English review" makes another name than english, which is kept.
        `  created  ${vault}/Settings/Workflows/english 1.md`,
        `  created  ${vault}/Settings/Workflows/english 2.md`,
        '  created  .gitignore',
        '  created  .pero/.gitignore',
        `  created  ${vault}/Settings/Agents/_Template.md`,
        `  kept     ${vault}/Settings/Workflows/`,
        '  created  .env',
        '  created  .pero/pero.sqlite',
        '',
        'Check these:',
        '  - Workflow english has 2 schedules, and a note holds one: it is english-1, english-2 now. Its past runs keep the name english.',
        '',
        `Checked 4 Agents and 2 Workflows in ${vault}/Settings: no problems.`,
        '',
        `Start Pero there with: cd ${workspace} && pero run`,
        `${legacy} is unchanged; Pero no longer needs it once this works.`,
        '',
      ].join('\n'),
    );
    expect(tree(legacy)).toEqual(before);
    expect(readFileSync(join(vault, 'Settings/Agents/coder.md'), 'utf8')).toBe(
      '---\ntopics:\n  - Kitchen\nprovider: codex\n---\n',
    );
    expect(
      readFileSync(join(vault, 'Settings/Workflows/english 2.md'), 'utf8'),
    ).toBe(
      '---\nagent: English\nchannel:\n  - English\nday: weekdays\nhour: 7\nminute: 30\n---\nSuggest better English.\n',
    );
    expect(await pero(['-w', workspace, 'check'])).toMatchObject({ code: 0 });
    expect(await pero(['--data-dir', legacy, 'migrate', workspace])).toEqual({
      code: 1,
      stdout: '',
      stderr: `${workspace} already has a database, in ${workspace}/.pero. Migrate into a workspace without one.\n`,
    });

    // The workspace's Pero has the same Agents, the Workflow split in two,
    // and resumes each Session.
    await start(resolveBootstrapConfig({ workspace, env: {} }));
    await connected();
    expect(
      (await client.call('agents.list')).agents.map((agent) => agent.name),
    ).toEqual(['coder', 'english', 'kitchen', 'main']);
    expect(
      (await client.call('workflows.list')).workflows.map(
        (workflow) => workflow.name,
      ),
    ).toEqual(['english-1', 'english-2']);
    await say(FORUM, ENGLISH, 'Back');
    const runtime = daemon!.app
      .get(AgentRuntimes)
      .get('claude') as FakeAgentRuntime;
    expect(runtime.requests.at(-1)!.providerSessionId).toBe(
      recorded.find((session) => session.agentName === 'english')!
        .providerSessionId,
    );
    expect((await pero(['-w', workspace, 'check'])).code).toBe(0);
  }, 90_000);

  it('refuses a folder that is no data directory, and --workspace', async () => {
    expect(await pero(['--data-dir', vault, 'migrate', workspace])).toEqual({
      code: 1,
      stdout: '',
      stderr: `${vault} has no Pero database (pero.sqlite); name the data directory to migrate with --data-dir\n`,
    });
    expect(await pero(['-w', workspace, 'migrate', workspace])).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'pero migrate takes the workspace as its argument, not --workspace; name the data directory with --data-dir\n',
    });
  });
});
