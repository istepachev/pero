import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlServer } from './control-server.js';
import {
  type DaemonMetadata,
  findRunningDaemon,
  readDaemonMetadata,
  removeDaemonMetadata,
  writeDaemonMetadata,
} from './daemon-metadata.js';
import type { StatusResult } from './protocol.js';

/** Handlers these tests never call. */
const unused = () => {
  throw new Error('not used in this test');
};
const UNUSED_HANDLERS = {
  'settings.get': unused,
  'settings.update': unused,
  'providers.check': unused,
  'backup.create': unused,
  'telegram.chats': unused,
  'telegram.allow': unused,
  'telegram.deny': unused,
  'agents.list': unused,
  'agents.get': unused,
  'agents.create': unused,
  'agents.edit': unused,
};

describe('daemon metadata', () => {
  let tmp: string;
  let path: string;
  let metadata: DaemonMetadata;
  let server: ControlServer | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-meta-'));
    path = join(tmp, 'pero.json');
    metadata = {
      pid: 4321,
      version: '1.2.3',
      dataDir: '/srv/pero',
      socket: join(tmp, 'pero.sock'),
      startedAt: '2026-09-28T00:00:00.000Z',
    };
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function listen(pid: number) {
    const status: StatusResult = {
      pid,
      version: metadata.version,
      dataDir: metadata.dataDir,
      startedAt: metadata.startedAt,
      uptimeMs: 1,
      health: 'ok',
      components: [],
    };
    server = new ControlServer({
      socketPath: metadata.socket,
      logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
      handlers: {
        ...UNUSED_HANDLERS,
        status: () => status,
        shutdown: () => ({}),
      },
    });
    await server.listen();
    return status;
  }

  it('round-trips through an owner-only file', () => {
    writeDaemonMetadata(path, metadata);

    expect(readDaemonMetadata(path)).toEqual(metadata);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(readdirSync(tmp)).toEqual(['pero.json']);

    removeDaemonMetadata(path);
    removeDaemonMetadata(path);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['not JSON', 'pid=4321'],
    ['not metadata', JSON.stringify({ pid: 'x' })],
  ])('reads nothing from a %s file', (_, content) => {
    if (content !== undefined) writeFileSync(path, content);

    expect(readDaemonMetadata(path)).toBeNull();
  });

  it('finds the daemon when its socket answers with the recorded pid', async () => {
    const status = await listen(metadata.pid);
    writeDaemonMetadata(path, metadata);

    await expect(findRunningDaemon(path)).resolves.toEqual({
      metadata,
      status,
    });
  });

  it('ignores metadata left behind when nothing answers', async () => {
    writeDaemonMetadata(path, metadata);

    await expect(findRunningDaemon(path)).resolves.toBeNull();
  });

  it('ignores metadata whose pid is not the one answering', async () => {
    await listen(metadata.pid + 1);
    writeDaemonMetadata(path, metadata);

    await expect(findRunningDaemon(path)).resolves.toBeNull();
  });
});
