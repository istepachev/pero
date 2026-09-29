import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { readDaemonMetadata } from '../src/control/daemon-metadata.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';

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
});
