import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { LoggerService } from '@nestjs/common';
import { MAX_SOCKET_PATH_BYTES } from '../config/workspace-layout.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  parseInput,
} from '../common/errors.js';
import {
  CONTROL_OPERATIONS,
  ControlError,
  type ControlErrorCode,
  type ControlOperation,
  type ControlResponse,
  type ControlResult,
  type ParsedControlParams,
  controlRequestSchema,
  isControlOperation,
  readLine,
} from './protocol.js';

/** How long a client may take to send its request line. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long closing waits for replies that are still being written. */
const CLOSE_GRACE_MS = 2000;

/** One function per operation, receiving validated parameters. */
export type ControlHandlers = {
  [Op in ControlOperation]: (
    params: ParsedControlParams<Op>,
  ) => ControlResult<Op> | Promise<ControlResult<Op>>;
};

/** The control socket cannot be opened. */
export class ControlSocketError extends Error {
  override name = 'ControlSocketError';
}

export interface ControlServerOptions {
  socketPath: string;
  handlers: ControlHandlers;
  /** Receives unexpected handler errors; carries its own context. */
  logger: LoggerService;
}

type ConnectionState = 'reading' | 'responding';

/**
 * Serves control requests on a Unix socket, one request per connection.
 * The socket is owner-only; so is the `run/` directory that holds it.
 */
export class ControlServer {
  private server: Server | undefined;
  private readonly connections = new Map<Socket, ConnectionState>();

  constructor(private readonly options: ControlServerOptions) {}

  async listen(): Promise<void> {
    const { socketPath } = this.options;
    const length = Buffer.byteLength(socketPath);
    if (length > MAX_SOCKET_PATH_BYTES) {
      throw new ControlSocketError(
        `Control socket path is too long (${length} bytes, at most ${MAX_SOCKET_PATH_BYTES}): ${socketPath}. Choose a workspace with a shorter path.`,
      );
    }
    // The daemon holds the workspace's lock, so a socket already here
    // is left over from a crash.
    rmSync(socketPath, { force: true });

    // Half-open: a client may end its side right after the request line.
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      void this.serve(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    this.server = server;
  }

  /**
   * Stops accepting connections and removes the socket. Replies already
   * being prepared get a short grace period; idle connections are dropped.
   */
  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;

    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    const responding: Promise<void>[] = [];
    for (const [socket, state] of this.connections) {
      if (state === 'reading') {
        socket.destroy();
      } else {
        responding.push(
          new Promise((resolve) => socket.once('close', resolve)),
        );
      }
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(responding),
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);
    for (const socket of this.connections.keys()) socket.destroy();
    await closed;
    rmSync(this.options.socketPath, { force: true });
  }

  private async serve(socket: Socket): Promise<void> {
    this.connections.set(socket, 'reading');
    socket.once('close', () => this.connections.delete(socket));
    // A client that goes away mid-reply is not the daemon's problem.
    socket.on('error', () => undefined);
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());

    let line: string | undefined;
    try {
      line = await readLine(socket);
    } catch (error) {
      if (!(error instanceof ControlError && error.code === 'too_large')) {
        socket.destroy();
        return;
      }
    }
    if (socket.destroyed) return;
    this.connections.set(socket, 'responding');
    socket.setTimeout(0);
    const response =
      line === undefined
        ? failure('invalid_request', 'Request is too large')
        : await this.dispatch(line);
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private async dispatch(line: string): Promise<ControlResponse> {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      json = undefined;
    }
    const request = controlRequestSchema.safeParse(json);
    if (!request.success) {
      return failure(
        'invalid_request',
        'A request is one JSON object with an "op" field',
      );
    }
    const { op, params } = request.data;
    if (!isControlOperation(op)) {
      return failure('unknown_operation', `Unknown operation: ${op}`);
    }

    try {
      const operation = CONTROL_OPERATIONS[op];
      const handler = this.options.handlers[op] as (params: unknown) => unknown;
      const result = await handler(parseInput(operation.params, params ?? {}));
      return { ok: true, result: operation.result.parse(result) };
    } catch (error) {
      return this.failureFor(op, error);
    }
  }

  private failureFor(op: string, error: unknown): ControlResponse {
    if (error instanceof InvalidInputError) {
      return failure('invalid_input', error.message);
    }
    if (error instanceof NotFoundError) {
      return failure('not_found', error.message);
    }
    if (error instanceof ConflictError) {
      return failure('conflict', error.message);
    }
    // Unexpected errors may carry internals or secrets; only the log sees them.
    this.options.logger.error(`Control operation ${op} failed`, error);
    return failure('internal', `Pero could not complete ${op}; see its log`);
  }
}

function failure(code: ControlErrorCode, message: string): ControlResponse {
  return { ok: false, error: { code, message } };
}
