import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentRuntime,
  RuntimeError,
  RuntimeEvent,
  RuntimeRequest,
} from '../../src/runtimes/agent-runtime.js';

/*
 * Runs real Codex turns through the built adapter, signed in with the
 * ChatGPT sign-in of the account running the test, which is what the Pero
 * service uses. Only with PERO_SMOKE_CODEX=1; `npm run test:smoke` builds
 * first. Each run uses a little of the subscription.
 */

const ENABLED = process.env.PERO_SMOKE_CODEX === '1';
/** The model the resumed turn switches to. */
const OTHER_MODEL = process.env.PERO_SMOKE_CODEX_MODEL ?? 'gpt-5.5';
const DIST = join(import.meta.dirname, '../../dist/runtimes/codex');
const TURN_SCRIPT = join(import.meta.dirname, 'codex-turn.mjs');
const CODEX = join(import.meta.dirname, '../../node_modules/.bin/codex');

type Request = Omit<RuntimeRequest, 'signal'>;
type CodexRuntimeClass =
  typeof import('../../src/runtimes/codex/codex-runtime.js').CodexRuntime;

function request(folder: string, overrides: Partial<Request>): Request {
  return {
    agentId: 1,
    input: '',
    instructions: 'Answer in as few words as possible.',
    providerOptions: { model: null, effort: 'low' },
    workingDirectory: folder,
    toolPolicy: { permissions: 'bypass' },
    ...overrides,
  };
}

async function collect(
  runtime: AgentRuntime,
  req: Request,
  signal = new AbortController().signal,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.execute({ ...req, signal })) {
    events.push(event);
  }
  return events;
}

async function failure(runtime: AgentRuntime, req: Request) {
  try {
    await collect(runtime, req);
  } catch (error) {
    return error as RuntimeError;
  }
  throw new Error('the turn did not fail');
}

function resultOf(events: RuntimeEvent[]): string {
  const result = events.find((event) => event.type === 'result');
  if (result?.type !== 'result') throw new Error('The turn had no result');
  return result.text;
}

function folder(prefix: string, git: boolean): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  if (git) execFileSync('git', ['init', '--quiet', path]);
  return path;
}

/**
 * Whether Codex's sandbox runs here. On Linux it needs unprivileged user
 * namespaces, which Ubuntu 24.04 and later restrict by default.
 */
function sandboxWorks(): boolean {
  try {
    execFileSync(CODEX, ['sandbox', '--', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)('Codex runtime (smoke)', { timeout: 240_000 }, () => {
  const folders: string[] = [];
  let CodexRuntime: CodexRuntimeClass;
  let runtime: AgentRuntime;
  let repo: string;
  let thread: string;

  beforeAll(async () => {
    ({ CodexRuntime } = (await import(
      join(DIST, 'codex-runtime.js')
    )) as typeof import('../../src/runtimes/codex/codex-runtime.js'));
    runtime = new CodexRuntime();
    repo = folder('pero-codex-smoke-', true);
    folders.push(repo);
  });

  afterAll(() => {
    for (const path of folders) rmSync(path, { recursive: true, force: true });
  });

  it('creates a thread and writes a file in the working directory', async () => {
    const events = await collect(
      runtime,
      request(repo, {
        input:
          'Create a file named hello.txt in the current folder containing ' +
          'exactly: pero-smoke',
      }),
    );

    const reported = events.find((event) => event.type === 'session');
    expect(reported?.type).toBe('session');
    if (reported?.type === 'session') thread = reported.providerSessionId;
    resultOf(events);
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8').trim()).toBe(
      'pero-smoke',
    );
  });

  it('resumes it in a new process with another model and effort', async () => {
    expect(thread).toBeDefined();
    const { stdout } = await promisify(execFile)(process.execPath, [
      TURN_SCRIPT,
      JSON.stringify(
        request(repo, {
          input:
            'Without using any tools: what exact text did you write to ' +
            'hello.txt earlier in this conversation?',
          providerOptions: { model: OTHER_MODEL, effort: 'medium' },
          providerSessionId: thread,
        }),
      ),
    ]);
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as RuntimeEvent | { type: string });

    expect(lines.at(-1)).toEqual({ type: 'end' });
    expect(lines).toContainEqual({
      type: 'session',
      providerSessionId: thread,
    });
    expect(resultOf(lines as RuntimeEvent[])).toContain('pero-smoke');
  });

  it('refuses a folder outside Git unless the Agent skips the check', async () => {
    const plain = folder('pero-codex-smoke-plain-', false);
    folders.push(plain);
    const turn = request(plain, { input: 'Reply with the word ok.' });

    const error = await failure(runtime, turn);
    expect(error.kind).toBe('failed');
    expect(error.message).toMatch(/Git repository/);

    const events = await collect(runtime, { ...turn, skipGitRepoCheck: true });
    expect(resultOf(events).toLowerCase()).toContain('ok');
  });

  describe.skipIf(!sandboxWorks())('an ask Agent, in the sandbox', () => {
    it('edits files in its folder', async () => {
      const events = await collect(
        runtime,
        request(repo, {
          input:
            'Create a file named asked.txt in the current folder ' +
            'containing exactly: inside',
          toolPolicy: { permissions: 'ask' },
        }),
      );

      resultOf(events);
      expect(readFileSync(join(repo, 'asked.txt'), 'utf8').trim()).toBe(
        'inside',
      );
    });

    it('cannot write outside its folder', async () => {
      const outside = folder('pero-codex-smoke-outside-', false);
      folders.push(outside);
      const target = join(outside, 'ran.txt');

      const events = await collect(
        runtime,
        request(repo, {
          input:
            'Run this exact shell command once, and do not retry it in ' +
            `any other way: touch ${target}`,
          toolPolicy: { permissions: 'ask' },
        }),
      );

      resultOf(events);
      expect(existsSync(target)).toBe(false);
    });
  });

  it('stops promptly when the turn is aborted', async () => {
    const abort = new AbortController();
    const started = Date.now();
    let abortedAt = 0;

    const turn = (async () => {
      for await (const event of runtime.execute({
        ...request(repo, {
          input: 'Run `sleep 1` in the shell sixty times, one call at a time.',
        }),
        signal: abort.signal,
      })) {
        if (abortedAt === 0 && event.type === 'tool') {
          abortedAt = Date.now();
          abort.abort();
        }
      }
    })();

    await expect(turn).rejects.toMatchObject({ kind: 'cancelled' });
    expect(abortedAt).toBeGreaterThan(started);
    expect(Date.now() - abortedAt).toBeLessThan(10_000);
  });

  it('reports a signed-out Codex as such', async () => {
    const home = folder('pero-codex-smoke-home-', false);
    folders.push(home);
    const signedOut = new CodexRuntime(undefined, {
      ...process.env,
      CODEX_HOME: home,
    });

    const error = await failure(
      signedOut,
      request(repo, { input: 'Reply with the word ok.' }),
    );

    expect(error.kind).toBe('auth');
  });
});
