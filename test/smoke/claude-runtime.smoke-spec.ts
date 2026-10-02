import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeRequest,
} from '../../src/runtimes/agent-runtime.js';

/*
 * Runs real Claude turns through the built adapter, signed in with the
 * Claude Code sign-in of the account running the test, which is what the
 * Pero service uses. Only with PERO_SMOKE_CLAUDE=1; `npm run test:smoke`
 * builds first. Each run uses a little of the subscription.
 */

const ENABLED = process.env.PERO_SMOKE_CLAUDE === '1';
const DIST = join(import.meta.dirname, '../../dist/runtimes/claude');
const TURN_SCRIPT = join(import.meta.dirname, 'claude-turn.mjs');

type Request = Omit<RuntimeRequest, 'signal'>;

function request(folder: string, overrides: Partial<Request>): Request {
  return {
    input: '',
    instructions: 'Answer in as few words as possible.',
    providerOptions: { model: 'haiku', effort: 'low' },
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

function resultOf(events: RuntimeEvent[]): string {
  const result = events.find((event) => event.type === 'result');
  if (result?.type !== 'result') throw new Error('The turn had no result');
  return result.text;
}

describe.skipIf(!ENABLED)(
  'Claude runtime (smoke)',
  { timeout: 180_000 },
  () => {
    let folder: string;
    let runtime: AgentRuntime;
    let session: string;

    beforeAll(async () => {
      folder = mkdtempSync(join(tmpdir(), 'pero-claude-smoke-'));
      const { ClaudeRuntime } = (await import(
        join(DIST, 'claude-runtime.js')
      )) as typeof import('../../src/runtimes/claude/claude-runtime.js');
      runtime = new ClaudeRuntime();
    });

    afterAll(() => {
      rmSync(folder, { recursive: true, force: true });
    });

    it('creates a session and writes a file in the working directory', async () => {
      const events = await collect(
        runtime,
        request(folder, {
          input:
            'Create a file named hello.txt in the current folder containing ' +
            'exactly: pero-smoke',
        }),
      );

      const reported = events.find((event) => event.type === 'session');
      expect(reported?.type).toBe('session');
      if (reported?.type === 'session') session = reported.providerSessionId;
      resultOf(events);
      expect(readFileSync(join(folder, 'hello.txt'), 'utf8').trim()).toBe(
        'pero-smoke',
      );
    });

    it('resumes it in a new process with another model and effort', async () => {
      expect(session).toBeDefined();
      const { stdout } = await promisify(execFile)(process.execPath, [
        TURN_SCRIPT,
        JSON.stringify(
          request(folder, {
            input:
              'Without using any tools: what exact text did you write to ' +
              'hello.txt earlier in this conversation?',
            providerOptions: { model: 'sonnet', effort: 'medium' },
            providerSessionId: session,
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
        providerSessionId: session,
      });
      expect(resultOf(lines as RuntimeEvent[])).toContain('pero-smoke');
    });

    it('reports a conversation Claude Code no longer has as lost', async () => {
      await expect(
        collect(
          runtime,
          request(folder, {
            input: 'Reply with the word ok.',
            providerSessionId: randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({ kind: 'session_lost' });
    });

    it('refuses a command when the Agent must ask and no one can answer', async () => {
      const events = await collect(
        runtime,
        request(folder, {
          input:
            'Use only the Bash tool to run this exact command, and do not ' +
            'create any file another way: ' +
            `node -e "require('fs').writeFileSync('ran.txt', 'x')"`,
          toolPolicy: { permissions: 'ask' },
        }),
      );

      resultOf(events);
      expect(existsSync(join(folder, 'ran.txt'))).toBe(false);
    });

    it('lets an ask Agent edit its folder but not the system folder when no one can answer', async () => {
      const system = join(folder, 'System');
      mkdirSync(join(system, 'Agents'), { recursive: true });
      writeFileSync(join(system, 'Agents', 'Health.md'), 'Be kind.\n');

      const events = await collect(
        runtime,
        request(folder, {
          input:
            'With the Write tool, write exactly "pero-note" to note.md and ' +
            'exactly "pero-system" to System/Agents/Health.md, both in ' +
            'the current folder. Use no other tool.',
          toolPolicy: { permissions: 'ask' },
          systemFolder: system,
        }),
      );

      resultOf(events);
      expect(readFileSync(join(folder, 'note.md'), 'utf8').trim()).toBe(
        'pero-note',
      );
      expect(readFileSync(join(system, 'Agents', 'Health.md'), 'utf8')).toBe(
        'Be kind.\n',
      );
    });

    it('stops promptly when the turn is aborted', async () => {
      const abort = new AbortController();
      const started = Date.now();
      let abortedAt = 0;

      const turn = (async () => {
        for await (const _ of runtime.execute({
          ...request(folder, {
            input: 'Run `sleep 1` in Bash sixty times, one call at a time.',
          }),
          signal: abort.signal,
        })) {
          if (abortedAt === 0) {
            abortedAt = Date.now();
            abort.abort();
          }
        }
      })();

      await expect(turn).rejects.toMatchObject({ kind: 'cancelled' });
      expect(abortedAt).toBeGreaterThan(started);
      expect(Date.now() - abortedAt).toBeLessThan(10_000);
    });
  },
);
