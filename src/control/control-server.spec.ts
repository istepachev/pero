import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import { createControlClient } from './client.js';
import {
  ControlServer,
  ControlSocketError,
  type ControlHandlers,
} from './control-server.js';
import { MAX_MESSAGE_BYTES, readLine, type StatusResult } from './protocol.js';

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
  'channels.list': unused,
  'channels.get': unused,
  'channels.assign': unused,
  'channels.setEnabled': unused,
  'channels.history': unused,
};

const status: StatusResult = {
  pid: 1234,
  version: '1.2.3',
  dataDir: '/srv/pero',
  startedAt: '2026-09-28T00:00:00.000Z',
  uptimeMs: 5,
  health: 'ok',
  components: [],
};

/** Sends `data` as-is and parses the one reply line. */
function rawRequest(socketPath: string, data: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => {
      socket.end(data);
      readLine(socket)
        .then((line) => resolve(JSON.parse(line)))
        .catch(reject)
        .finally(() => socket.destroy());
    });
    socket.once('error', reject);
  });
}

describe('ControlServer', () => {
  let tmp: string;
  let socketPath: string;
  let server: ControlServer | undefined;
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-ctl-'));
    socketPath = join(tmp, 'pero.sock');
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.clearAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function listen(handlers: Partial<ControlHandlers> = {}) {
    server = new ControlServer({
      socketPath,
      logger,
      handlers: {
        ...UNUSED_HANDLERS,
        status: () => status,
        shutdown: () => ({}),
        ...handlers,
      },
    });
    await server.listen();
    return createControlClient(socketPath);
  }

  it('answers through the client and is owner-only', async () => {
    const client = await listen();

    await expect(client.status()).resolves.toEqual(status);
    expect(statSync(socketPath).mode & 0o077).toBe(0);
  });

  it('serves concurrent clients', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const client = await listen({
      shutdown: async () => {
        await slow;
        return {};
      },
    });

    const pending = client.shutdown();
    await expect(client.status()).resolves.toEqual(status);
    release();
    await expect(pending).resolves.toBeUndefined();
  });

  it.each([
    ['invalid JSON', 'not json\n', 'invalid_request'],
    ['a non-object', '[1]\n', 'invalid_request'],
    ['a missing op', '{}\n', 'invalid_request'],
    ['an unknown op', '{"op":"launch"}\n', 'unknown_operation'],
    ['an inherited op name', '{"op":"toString"}\n', 'unknown_operation'],
    ['unknown params', '{"op":"status","params":{"x":1}}\n', 'invalid_input'],
  ])('rejects %s', async (_name, request, code) => {
    await listen();

    await expect(rawRequest(socketPath, request)).resolves.toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it('rejects a request line over the size limit', async () => {
    await listen();

    const huge = `{"op":"status","params":"${'x'.repeat(MAX_MESSAGE_BYTES)}"}\n`;
    await expect(rawRequest(socketPath, huge)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it.each([
    [new InvalidInputError('bad'), InvalidInputError],
    [new NotFoundError('missing'), NotFoundError],
    [new ConflictError('taken'), ConflictError],
  ])('passes %s back to the client', async (error, type) => {
    const client = await listen({
      status: () => {
        throw error;
      },
    });

    const call = client.status();
    await expect(call).rejects.toThrow(type);
    await expect(call).rejects.toThrow(error.message);
  });

  it('logs an unexpected error and answers without its details', async () => {
    const error = new Error('token 123:secret leaked');
    const client = await listen({
      status: () => {
        throw error;
      },
    });

    const call = client.status();
    await expect(call).rejects.toMatchObject({ code: 'internal' });
    await expect(call).rejects.not.toThrow(/secret/);
    expect(logger.error).toHaveBeenCalledWith(
      'Control operation status failed',
      error,
    );
  });

  it('refuses a result that breaks its schema', async () => {
    const client = await listen({
      status: () => ({ ...status, pid: -1 }),
    });

    await expect(client.status()).rejects.toMatchObject({ code: 'internal' });
  });

  it('finishes a reply in progress when closing, then removes the socket', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    const client = await listen({
      shutdown: async () => {
        entered = true;
        await slow;
        return {};
      },
    });

    const pending = client.shutdown();
    await vi.waitFor(() => expect(entered).toBe(true));
    const closing = server!.close();
    setTimeout(release, 50);

    await expect(pending).resolves.toBeUndefined();
    await closing;
    server = undefined;
    expect(() => statSync(socketPath)).toThrow(/ENOENT/);
  });

  it('drops a connection that never sends a request when closing', async () => {
    await listen();
    const idle = connect(socketPath);
    await new Promise((resolve) => idle.once('connect', resolve));
    const closed = new Promise((resolve) => idle.once('close', resolve));

    const started = Date.now();
    await server!.close();
    server = undefined;

    await closed;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('replaces a socket left behind by an earlier server', async () => {
    writeFileSync(socketPath, '');

    const client = await listen();

    await expect(client.status()).resolves.toEqual(status);
  });

  it('refuses a socket path the OS cannot hold', async () => {
    socketPath = join(tmp, 'x'.repeat(120), 'pero.sock');

    await expect(listen()).rejects.toThrow(ControlSocketError);
    await expect(listen()).rejects.toThrow(/too long/);
  });
});
