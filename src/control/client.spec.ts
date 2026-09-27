import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createControlClient, DaemonNotRunningError } from './client.js';
import { ControlError } from './protocol.js';

describe('createControlClient', () => {
  let tmp: string;
  let socketPath: string;
  let server: Server | undefined;
  const sockets = new Set<Socket>();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-client-'));
    socketPath = join(tmp, 'pero.sock');
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) =>
      server ? server.close(resolve) : resolve(undefined),
    );
    server = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A fake daemon that answers every connection with `reply`, if given. */
  async function fakeDaemon(reply?: string) {
    server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      if (reply !== undefined) socket.end(reply);
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  }

  it('reports a missing socket as a stopped daemon', async () => {
    const client = createControlClient(join(tmp, 'missing', 'pero.sock'));

    const call = client.status();
    await expect(call).rejects.toThrow(DaemonNotRunningError);
    await expect(call).rejects.toThrow(
      "Pero isn't running — start it with pero run",
    );
  });

  it('times out when the daemon does not answer', async () => {
    await fakeDaemon();
    const client = createControlClient(socketPath, { timeoutMs: 50 });

    await expect(client.status()).rejects.toMatchObject({
      name: 'ControlError',
      code: 'timeout',
    });
  });

  it.each([
    ['an unreadable reply', 'hello\n'],
    ['a reply of the wrong shape', '{"ok":"yes"}\n'],
    ['a result of another version', '{"ok":true,"result":{"pid":"one"}}\n'],
  ])('rejects %s', async (_name, reply) => {
    await fakeDaemon(reply);

    await expect(
      createControlClient(socketPath).status(),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a connection closed without a reply', async () => {
    await fakeDaemon('');

    await expect(
      createControlClient(socketPath).status(),
    ).rejects.toBeInstanceOf(ControlError);
  });

  it('keeps an error code it does not know', async () => {
    await fakeDaemon(
      '{"ok":false,"error":{"code":"busy","message":"Try again"}}\n',
    );

    await expect(
      createControlClient(socketPath).status(),
    ).rejects.toMatchObject({
      name: 'ControlError',
      code: 'busy',
      message: 'Try again',
    });
  });

  it('ignores result fields added by a newer daemon', async () => {
    await fakeDaemon('{"ok":true,"result":{"draining":false}}\n');

    await expect(
      createControlClient(socketPath).shutdown(),
    ).resolves.toBeUndefined();
  });
});
