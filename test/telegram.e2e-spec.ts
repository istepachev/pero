import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompts } from '../src/cli/prompts.js';
import { runInteractiveSetup } from '../src/cli/setup/interactive-setup.js';
import { NotFoundError } from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { Channel } from '../src/persistence/entities/channel.entity.js';
import { Session } from '../src/persistence/entities/session.entity.js';
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
const DIRECT: Chat.PrivateChat = {
  id: 1234,
  type: 'private',
  first_name: 'Ada',
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };

describe('Telegram chats and pairing (e2e)', () => {
  let tmp: string;
  let workspace: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;
  let nextMessageId: number;

  beforeEach(async () => {
    api = new FakeBotApi();
    api.chats.set(String(FORUM.id), FORUM);
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    workspace = join(tmp, 'ws');
    initWorkspace(workspace, tmp);
    client = createControlClient(join(workspace, '.pero', 'run', 'pero.sock'));
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A daemon on the fake Bot API whose Agents answer with an echo. */
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
  }

  /** The Agent notes, by file name. */
  function agentNotes(): string[] {
    return readdirSync(join(workspace, 'data', 'Settings', 'Agents')).sort();
  }

  function db(): DataSource {
    return daemon!.app.get<DataSource>(getDataSourceToken());
  }

  function message(chat: Chat, text: string): UpdateBody {
    return {
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat,
        from: OWNER,
        text,
      } as never,
    };
  }

  /** The texts Telegram has been asked to send, once there are `count`. */
  async function sentTexts(count: number): Promise<string[]> {
    await vi.waitFor(() => expect(api.sent()).toHaveLength(count));
    return api.sent().map((payload) => String(payload.text));
  }

  it('lists, allows, and denies chats, resuming a Channel allowed again', async () => {
    await start();

    api.push(message(FORUM, 'Anyone there?'));
    expect(await sentTexts(1)).toEqual([
      expect.stringContaining('pero telegram allow -1001234567890'),
    ]);
    expect(await client.call('telegram.chats')).toMatchObject({
      allowed: [],
      pairing: [
        { chatId: '-1001234567890', kind: 'group', title: 'Household' },
      ],
    });

    const allowed = await client.call('telegram.allow', {
      chatId: '-1001234567890',
    });
    expect(allowed).toMatchObject({
      alreadyAllowed: false,
      chat: { kind: 'group', title: 'Household', bot: 'administrator' },
    });
    expect(await client.call('telegram.chats')).toMatchObject({
      allowed: [{ chatId: '-1001234567890', topics: true }],
      pairing: [],
    });
    await vi.waitFor(async () =>
      expect(
        (await client.status()).components.find((c) => c.name === 'telegram'),
      ).toMatchObject({ state: 'ok', detail: 'Connected as @pero_test_bot' }),
    );

    // The General topic onboards the main Agent, which answers.
    api.push(message(FORUM, 'One'));
    expect((await sentTexts(3)).at(-1)).toBe('echo: One');
    const [session] = await db().getRepository(Session).find();

    await client.call('telegram.deny', { chatId: '-1001234567890' });
    await expect(
      client.call('telegram.deny', { chatId: '-1001234567890' }),
    ).rejects.toThrow(NotFoundError);
    const denied = api.push(message(FORUM, 'Two'));
    // Handled once the next poll confirms it: no reply, since the chat had
    // its pairing hint this hour, and nothing reached an Agent.
    await vi.waitFor(() =>
      expect(
        api
          .callsOf('getUpdates')
          .some((call) => Number(call.payload.offset) > denied),
      ).toBe(true),
    );
    expect(api.sent()).toHaveLength(3);

    await client.call('telegram.allow', { chatId: '-1001234567890' });
    api.push(message(FORUM, 'Three'));
    expect((await sentTexts(4)).at(-1)).toBe('echo: Three');

    expect(await db().getRepository(Session).find()).toEqual([
      expect.objectContaining({
        id: session!.id,
        status: 'active',
        providerSessionId: session!.providerSessionId,
      }),
    ]);
    expect(await db().getRepository(Channel).count()).toBe(1);
    expect(agentNotes()).toEqual(['Main.md', '_Template.md']);
  });

  it('allows a chat that sends its first message during interactive setup', async () => {
    await start();
    const asked: string[] = [];
    const prompts: Prompts = {
      input: ({ message: text, signal }) => {
        asked.push(text);
        if (!text.startsWith('Waiting for a message')) {
          // Provider sign-in, which this test skips.
          return Promise.resolve('s');
        }
        api.push(message(DIRECT, 'Hello Pero'));
        return new Promise((_, reject) =>
          signal?.addEventListener('abort', () =>
            reject(
              Object.assign(new Error('aborted'), {
                name: 'AbortPromptError',
              }),
            ),
          ),
        );
      },
      password: () => Promise.reject(new Error('not asked')),
      confirm: ({ message: text }) => {
        asked.push(text);
        return Promise.resolve(true);
      },
    };

    await runInteractiveSetup(
      {
        client,
        prompts,
        print: () => undefined,
        pollIntervalMs: 20,
      },
      {
        status: await client.status(),
        settings: await client.call('settings.get'),
      },
    );

    expect(asked.slice(0, 2)).toEqual([
      'Waiting for a message to @pero_test_bot (Enter to skip)',
      'Allow direct chat "Ada" (1234)?',
    ]);
    expect((await client.call('telegram.chats')).allowed).toEqual([
      expect.objectContaining({ chatId: '1234', kind: 'private' }),
    ]);

    api.push(message(DIRECT, 'Again'));
    await vi.waitFor(() =>
      expect(api.sent().at(-1)).toMatchObject({
        chat_id: '1234',
        text: 'echo: Again',
      }),
    );
  });
});
