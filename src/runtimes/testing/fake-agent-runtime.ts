import type { Provider } from '../../config/provider-options.js';
import {
  type AgentRuntime,
  RuntimeError,
  type RuntimeEvent,
  type RuntimeRequest,
} from '../agent-runtime.js';

/** A turn `hold` keeps running until the test lets it finish. */
export interface HeldTurn {
  /** Resolves with the turn's request once it is running. */
  started: Promise<RuntimeRequest>;
  /** Lets the turn finish. */
  release(): void;
}

type Script =
  | { kind: 'hold'; held: Deferred<void>; started: Deferred<RuntimeRequest> }
  | { kind: 'fail'; error: RuntimeError };

/**
 * An in-memory runtime for tests. Each turn reports a session (the resumed
 * one, or a new `fake-<kind>-<n>`) and answers `echo: <input>`. `hold` and
 * `failNext` script the next turns in order; `requests` records every one.
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly requests: RuntimeRequest[] = [];
  private readonly scripts: Script[] = [];
  private nextSession = 1;

  constructor(readonly kind: Provider) {}

  /** Makes the next unscripted turn wait, once its session is reported. */
  hold(): HeldTurn {
    const held = deferred<void>();
    const started = deferred<RuntimeRequest>();
    this.scripts.push({ kind: 'hold', held, started });
    return { started: started.promise, release: () => held.resolve() };
  }

  /** Makes the next unscripted turn fail with `error`. */
  failNext(error = new RuntimeError('failed', 'The model is overloaded')) {
    this.scripts.push({ kind: 'fail', error });
  }

  async *execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    this.requests.push(request);
    const script = this.scripts.shift();
    yield {
      type: 'session',
      providerSessionId:
        request.providerSessionId ?? `fake-${this.kind}-${this.nextSession++}`,
    };
    if (script?.kind === 'hold') {
      script.started.resolve(request);
      await untilAborted(script.held.promise, request.signal);
    }
    if (script?.kind === 'fail') throw script.error;
    yield { type: 'result', text: `echo: ${request.input}` };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Waits for `work`, or throws a cancelled error when `signal` aborts first. */
function untilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new RuntimeError('cancelled', 'Turn aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    void work.then(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
  });
}
