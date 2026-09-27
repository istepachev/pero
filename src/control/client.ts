import { connect } from 'node:net';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import {
  CONTROL_OPERATIONS,
  ControlError,
  type ControlOperation,
  type ControlParams,
  type ControlResult,
  controlResponseSchema,
  readLine,
  type StatusResult,
} from './protocol.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

export const DEFAULT_CONTROL_TIMEOUT_MS = 5000;

/** Nothing answers on the control socket: the daemon is stopped. */
export class DaemonNotRunningError extends Error {
  override name = 'DaemonNotRunningError';

  constructor(
    readonly socketPath: string,
    options?: ErrorOptions,
  ) {
    super("Pero isn't running — start it with pero run", options);
  }
}

export interface ControlClientOptions {
  /** How long to wait for the daemon, per request. */
  timeoutMs?: number;
}

export interface ControlClient {
  call<Op extends ControlOperation>(
    op: Op,
    params?: ControlParams<Op>,
  ): Promise<ControlResult<Op>>;
  status(): Promise<StatusResult>;
  /** Asks the daemon to stop; resolves once it has accepted. */
  shutdown(): Promise<void>;
}

/**
 * A client for the daemon listening on `socketPath`. Every call opens its
 * own connection, so calls may run concurrently. Replies are validated;
 * errors the daemon reports come back as `InvalidInputError`,
 * `NotFoundError`, `ConflictError`, or `ControlError`.
 */
export function createControlClient(
  socketPath: string,
  options: ControlClientOptions = {},
): ControlClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

  async function call<Op extends ControlOperation>(
    op: Op,
    params?: ControlParams<Op>,
  ): Promise<ControlResult<Op>> {
    const line = await exchange(
      socketPath,
      JSON.stringify({ op, params: params ?? {} }),
      timeoutMs,
    );
    const response = parseResponse(line);
    if (!response.ok) throw errorFromResponse(response.error);

    const result = CONTROL_OPERATIONS[op].result.safeParse(response.result);
    if (!result.success) {
      throw new ControlError(
        'invalid_response',
        `Unexpected reply to ${op}; the running daemon may be a different Pero version`,
      );
    }
    return result.data as ControlResult<Op>;
  }

  return {
    call,
    status: () => call('status'),
    shutdown: async () => {
      await call('shutdown');
    },
  };
}

/** Sends one request line and resolves with the reply line. */
function exchange(
  socketPath: string,
  request: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(
        new ControlError(
          'timeout',
          `Pero did not answer within ${timeoutMs} ms`,
        ),
      );
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        reject(new DaemonNotRunningError(socketPath, { cause: error }));
      } else {
        reject(
          new ControlError(
            'connection',
            `Cannot reach Pero at ${socketPath}: ${error.message}`,
            { cause: error },
          ),
        );
      }
    });
    socket.once('connect', () => {
      socket.end(`${request}\n`);
      readLine(socket)
        .then(resolve, reject)
        .finally(() => socket.destroy());
    });
  });
}

function parseResponse(line: string) {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    json = undefined;
  }
  const response = controlResponseSchema.safeParse(json);
  if (!response.success) {
    throw new ControlError(
      'invalid_response',
      'The daemon sent a reply this CLI cannot read',
    );
  }
  return response.data;
}

function errorFromResponse(error: { code: string; message: string }): Error {
  switch (error.code) {
    case 'invalid_input':
      return new InvalidInputError(error.message);
    case 'not_found':
      return new NotFoundError(error.message);
    case 'conflict':
      return new ConflictError(error.message);
    default:
      return new ControlError(error.code, error.message);
  }
}
