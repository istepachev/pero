import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { readDaemonMetadata } from '../src/control/daemon-metadata.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { Channel } from '../src/persistence/entities/channel.entity.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';

// `npm run test:e2e` builds first.
const PERO = join(import.meta.dirname, '../bin/pero.js');

const HOME_CHAT = '-1001234567890';

describe('Settings notes in the daemon (e2e)', { timeout: 60_000 }, () => {
  let tmp: string;
  let workspace: string;
  let app: Daemon | undefined;
  let api: FakeBotApi;

  beforeEach(async () => {
    api = new FakeBotApi();
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    workspace = join(tmp, 'ws');
    initWorkspace(workspace, tmp);
  });

  afterEach(async () => {
    await app?.stop('test finished');
    app = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function start(): Promise<ControlClient> {
    app = await startDaemon({
      config: resolveBootstrapConfig({ workspace, env: {} }),
      foreground: false,
      // Telegram is the fake Bot API, never the real one.
      env: { PERO_TELEGRAM_API_ROOT: api.url },
    });
    const metadata = readDaemonMetadata(
      join(workspace, '.pero', 'run', 'pero.json'),
    )!;
    return createControlClient(metadata.socket);
  }

  /** Runs `pero -w <workspace> check` to completion. */
  function check(...args: string[]) {
    const {
      PERO_WORKSPACE: _workspace,
      PERO_TELEGRAM_BOT_TOKEN: _token,
      ...env
    } = process.env;
    return new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        [PERO, '-w', workspace, 'check', ...args],
        { env: { ...env, HOME: tmp }, cwd: tmp },
        (error, stdout) => {
          resolve({ code: error ? (error.code as number) : 0, stdout });
        },
      );
    });
  }

  /** Channels Pero has seen in the allowed Home group: General and Health. */
  async function seeTopics() {
    await app!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(Channel)
      .insert([
        {
          integrationKind: 'telegram',
          externalKey: HOME_CHAT,
          address: { chatId: HOME_CHAT },
          title: 'Home',
        },
        {
          integrationKind: 'telegram',
          externalKey: `${HOME_CHAT}:5`,
          address: { chatId: HOME_CHAT, messageThreadId: '5' },
          title: 'Health',
        },
        {
          // Not allowed, so not seen.
          integrationKind: 'telegram',
          externalKey: '-1009:7',
          address: { chatId: '-1009', messageThreadId: '7' },
          title: 'Finance',
        },
      ]);
  }

  const settingsOf = async (client: ControlClient) =>
    (await client.status()).components.find(
      (component) => component.name === 'settings',
    );

  it('reports the notes as a settings component, following edits', async () => {
    const note = join(workspace, 'data', 'Settings', 'Agents', 'Coach.md');
    writeFileSync(note, '---\nmodle: sonnet\n---\nCoach');
    const client = await start();

    expect(await settingsOf(client)).toMatchObject({
      state: 'degraded',
      detail: '1 note has errors; run pero check',
      required: true,
    });

    writeFileSync(note, '---\nmodel: sonnet\n---\nCoach');
    await vi.waitFor(
      async () => expect((await settingsOf(client))?.state).toBe('ok'),
      { timeout: 25_000, interval: 500 },
    );
  });

  it('checks Workflow topics against the topics Pero has seen', async () => {
    const settings = join(workspace, 'data', 'Settings');
    writeFileSync(
      join(workspace, '.pero', 'config.yaml'),
      `data: data\ntelegram:\n  allowed-chats:\n    - id: ${HOME_CHAT}\n      title: Home\n`,
    );
    writeFileSync(
      join(settings, 'Agents', 'Health.md'),
      '---\ntopics: Health\n---\nCoach',
    );
    writeFileSync(
      join(settings, 'Workflows', 'Report.md'),
      '---\nhour: 12\nchannel: Health\n---\nReport',
    );
    writeFileSync(
      join(settings, 'Workflows', 'Typo.md'),
      '---\nhour: 12\nchannel: [Helth, Home/General]\nhistory: true\nhistory-channels: Finance\n---\nReport',
    );
    await start();
    await seeTopics();

    const running = await check();
    expect(running.code).toBe(1);
    expect(running.stdout).toBe(
      [
        'data/Settings/Workflows/Typo.md',
        '  channel: no topic titled "Helth"; seen topics: General, Health',
        '  history-channels: no topic titled "Finance"; seen topics: General, Health',
        '',
        '2 problems in 1 file.',
        '',
      ].join('\n'),
    );
    expect(JSON.parse((await check('--json')).stdout)).toMatchObject({
      topicsChecked: true,
      workflows: 1,
    });

    await app!.stop('checking without Pero');
    app = undefined;
    const stopped = await check();
    expect(stopped).toEqual({
      code: 0,
      stdout: [
        'Checked 2 Agents and 2 Workflows in data/Settings: no problems.',
        "Topic titles weren't checked against Telegram's topics, since Pero isn't running.",
        '',
      ].join('\n'),
    });
  });
});
