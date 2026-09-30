import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  AbortError,
  type CanUseTool,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeError,
  type RuntimeEvent,
  type RuntimeRequest,
} from '../agent-runtime.js';
import {
  ClaudeRuntime,
  type ClaudeQuery,
  NO_APPROVER,
  NO_SETTINGS_APPROVER,
  summarize,
} from './claude-runtime.js';
import {
  assistant,
  init,
  SESSION,
  success,
} from './testing/claude-messages.js';

const ENV = { PATH: '/usr/bin', HOME: '/home/owner' };

function request(overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    input: 'Hello',
    instructions: '',
    providerOptions: { model: null, effort: null },
    workingDirectory: '/home/owner/vault',
    toolPolicy: { permissions: 'ask' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A `query` that plays `script` and records what it was called with. */
function fakeQuery(
  script: (options: Options) => AsyncIterable<SDKMessage> = async function* () {
    yield init();
    yield assistant([{ type: 'text', text: 'Hi' }]);
    yield success('Hi');
  },
) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: ClaudeQuery = (params) => {
    calls.push(params);
    return script(params.options);
  };
  return { query, calls };
}

async function collect(
  events: AsyncIterable<RuntimeEvent>,
): Promise<RuntimeEvent[]> {
  const all: RuntimeEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function failure(events: AsyncIterable<RuntimeEvent>) {
  try {
    await collect(events);
  } catch (error) {
    return error as RuntimeError;
  }
  throw new Error('the turn did not fail');
}

/** The `canUseTool` a turn of `req` hands the SDK. */
async function canUseTool(req: RuntimeRequest): Promise<CanUseTool> {
  const { query, calls } = fakeQuery();
  await collect(new ClaudeRuntime(query, ENV).execute(req));
  return calls[0]!.options.canUseTool!;
}

const toolOptions = {
  signal: new AbortController().signal,
  toolUseID: 'tool-1',
  requestId: 'request-1',
};

describe('ClaudeRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a turn and reports its events', async () => {
    const { query, calls } = fakeQuery();

    const events = await collect(
      new ClaudeRuntime(query, ENV).execute(request()),
    );

    expect(events).toEqual([
      { type: 'session', providerSessionId: SESSION },
      { type: 'text', delta: 'Hi' },
      { type: 'result', text: 'Hi' },
    ]);
    expect(calls[0]!.prompt).toBe('Hello');
  });

  it('works in the folder like Claude Code, leaving out unset options', async () => {
    const { query, calls } = fakeQuery();

    await collect(new ClaudeRuntime(query, ENV).execute(request()));

    const { options } = calls[0]!;
    expect(options).toMatchObject({
      cwd: '/home/owner/vault',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      env: ENV,
    });
    expect(options.systemPrompt).not.toHaveProperty('append');
    for (const option of ['model', 'effort', 'resume']) {
      expect(options).not.toHaveProperty(option);
    }
    expect(options.abortController).toBeInstanceOf(AbortController);
  });

  it('passes the model, effort, instructions, and the session to resume', async () => {
    const { query, calls } = fakeQuery();

    await collect(
      new ClaudeRuntime(query, ENV).execute(
        request({
          instructions: 'Be kind.\n\nBe brief.',
          providerOptions: { model: 'claude-sonnet-5', effort: 'xhigh' },
          providerSessionId: SESSION,
        }),
      ),
    );

    expect(calls[0]!.options).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'xhigh',
      resume: SESSION,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Be kind.\n\nBe brief.',
      },
    });
  });

  it('refuses an effort level Claude does not have', async () => {
    const { query, calls } = fakeQuery();

    const error = await failure(
      new ClaudeRuntime(query, ENV).execute(
        request({ providerOptions: { model: null, effort: 'minimal' } }),
      ),
    );

    expect(error).toMatchObject({ kind: 'failed' });
    expect(error.message).toMatch(/minimal/);
    expect(calls).toEqual([]);
  });

  it('never passes on an API key, so Claude Code keeps using the sign-in', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { query, calls } = fakeQuery();

    await collect(
      new ClaudeRuntime(query, {
        ...ENV,
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        ANTHROPIC_AUTH_TOKEN: 'token',
      }).execute(request()),
    );

    expect(calls[0]!.options.env).toEqual(ENV);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-ant-secret');
  });

  describe('permissions', () => {
    it('lets a bypass Agent use every tool without asking', async () => {
      const { query, calls } = fakeQuery();

      await collect(
        new ClaudeRuntime(query, ENV).execute(
          request({ toolPolicy: { permissions: 'bypass' } }),
        ),
      );

      expect(calls[0]!.options).toMatchObject({
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });
      expect(calls[0]!.options).not.toHaveProperty('canUseTool');
    });

    it("decides about an ask Agent's tools itself", async () => {
      const { query, calls } = fakeQuery();

      await collect(new ClaudeRuntime(query, ENV).execute(request()));

      expect(calls[0]!.options.permissionMode).toBe('default');
      expect(calls[0]!.options).not.toHaveProperty(
        'allowDangerouslySkipPermissions',
      );
      expect(calls[0]!.options.canUseTool).toBeTypeOf('function');
    });

    it('refuses a tool when no one can be asked', async () => {
      const ask = await canUseTool(request());

      expect(await ask('Bash', { command: 'ls' }, toolOptions)).toEqual({
        behavior: 'deny',
        message: `Not allowed: ${NO_APPROVER}`,
      });
    });

    it('asks the owner, and follows the answer', async () => {
      const approve = vi
        .fn()
        .mockResolvedValueOnce({ allow: true })
        .mockResolvedValueOnce({ allow: false, reason: 'the owner said no' });
      const ask = await canUseTool(request({ approve }));
      const input = { command: 'curl -sI https://example.com' };

      expect(await ask('Bash', input, toolOptions)).toEqual({
        behavior: 'allow',
        updatedInput: input,
      });
      expect(await ask('Bash', input, toolOptions)).toEqual({
        behavior: 'deny',
        message: 'Not allowed: the owner said no',
      });
      expect(approve).toHaveBeenCalledWith({
        tool: 'Bash',
        summary: 'Bash: curl -sI https://example.com',
        signal: toolOptions.signal,
      });
    });

    it("shows Claude Code's own description of the request when it has one", async () => {
      const approve = vi.fn().mockResolvedValue({ allow: true });
      const ask = await canUseTool(request({ approve }));

      await ask(
        'WebFetch',
        { url: 'https://example.com' },
        { ...toolOptions, title: 'Claude wants to fetch example.com' },
      );

      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: 'Claude wants to fetch example.com',
        }),
      );
    });

    it('refuses the tool when asking fails', async () => {
      const approve = vi.fn().mockRejectedValue(new Error('Telegram is down'));
      const ask = await canUseTool(request({ approve }));

      expect(await ask('Bash', { command: 'ls' }, toolOptions)).toEqual({
        behavior: 'deny',
        message: 'Not allowed: asking the owner failed: Telegram is down',
      });
    });
  });

  describe('the settings folder', () => {
    let vault: string;
    let settings: string;
    let health: string;

    beforeEach(() => {
      vault = mkdtempSync(join(tmpdir(), 'pero-claude-runtime-'));
      settings = join(vault, 'Settings');
      mkdirSync(join(settings, 'Agents'), { recursive: true });
      health = join(settings, 'Agents', 'Health.md');
    });

    afterEach(() => {
      rmSync(vault, { recursive: true, force: true });
    });

    function inVault(overrides: Partial<RuntimeRequest> = {}) {
      return request({
        workingDirectory: vault,
        settingsFolder: settings,
        ...overrides,
      });
    }

    it('lets an ask Agent edit a note in its folder without asking', async () => {
      const approve = vi.fn();
      const ask = await canUseTool(inVault({ approve }));
      const input = {
        file_path: join(vault, 'Groceries.md'),
        content: '- milk',
      };

      expect(await ask('Write', input, toolOptions)).toEqual({
        behavior: 'allow',
        updatedInput: input,
      });
      expect(approve).not.toHaveBeenCalled();
    });

    it('asks before an edit under the settings folder, and follows the answer', async () => {
      const approve = vi
        .fn()
        .mockResolvedValueOnce({ allow: true })
        .mockResolvedValueOnce({ allow: false, reason: 'the owner said no' });
      const ask = await canUseTool(inVault({ approve }));
      const input = {
        file_path: health,
        old_string: 'ask',
        new_string: 'bypass',
      };

      expect(await ask('Edit', input, toolOptions)).toEqual({
        behavior: 'allow',
        updatedInput: input,
      });
      expect(await ask('Edit', input, toolOptions)).toEqual({
        behavior: 'deny',
        message: 'Not allowed: the owner said no',
      });
      expect(approve).toHaveBeenCalledWith({
        tool: 'Edit',
        summary: `Change Pero's settings: Edit: ${health}`,
        signal: toolOptions.signal,
      });
    });

    it('asks however the path reaches the settings folder', async () => {
      symlinkSync(join(settings, 'Agents'), join(vault, 'Agents'));
      const approve = vi.fn().mockResolvedValue({ allow: false, reason: 'no' });
      const ask = await canUseTool(inVault({ approve }));

      for (const file_path of [
        join(vault, 'Agents', 'Health.md'),
        join('..', basename(vault), 'Settings', 'Agents', 'Health.md'),
        join(vault, 'Notes', '..', 'Settings', 'Agents', 'Health.md'),
      ]) {
        await ask('Write', { file_path, content: '' }, toolOptions);
      }

      expect(approve).toHaveBeenCalledTimes(3);
    });

    it('refuses an edit under the settings folder when no one can be asked, as in a Workflow run', async () => {
      const ask = await canUseTool(inVault());

      expect(
        await ask('Write', { file_path: health, content: '' }, toolOptions),
      ).toEqual({
        behavior: 'deny',
        message: `Not allowed: ${NO_SETTINGS_APPROVER}`,
      });
      expect(
        await ask(
          'Write',
          { file_path: join(vault, 'Groceries.md'), content: '' },
          toolOptions,
        ),
      ).toMatchObject({ behavior: 'allow' });
    });

    it('leaves a bypass Agent free to edit it', async () => {
      const { query, calls } = fakeQuery();

      await collect(
        new ClaudeRuntime(query, ENV).execute(
          inVault({ toolPolicy: { permissions: 'bypass' } }),
        ),
      );

      expect(calls[0]!.options.permissionMode).toBe('bypassPermissions');
      expect(calls[0]!.options).not.toHaveProperty('canUseTool');
    });
  });

  describe('cancellation', () => {
    it('never starts a turn whose signal has already aborted', async () => {
      const { query, calls } = fakeQuery();
      const abort = new AbortController();
      abort.abort();

      const error = await failure(
        new ClaudeRuntime(query, ENV).execute(
          request({ signal: abort.signal }),
        ),
      );

      expect(error).toMatchObject({ kind: 'cancelled' });
      expect(calls).toEqual([]);
    });

    it('stops Claude Code when the signal aborts mid-turn', async () => {
      const abort = new AbortController();
      let sdkSignal: AbortSignal | undefined;
      const { query } = fakeQuery(async function* (options) {
        sdkSignal = options.abortController!.signal;
        yield init();
        yield assistant([{ type: 'text', text: 'Counting…' }]);
        // The caller aborts while this waits at the last yield.
        if (!sdkSignal.aborted) {
          await new Promise((resolve) =>
            sdkSignal!.addEventListener('abort', resolve, { once: true }),
          );
        }
        throw new AbortError('Claude Code process aborted by user');
      });

      const events: RuntimeEvent[] = [];
      let error: unknown;
      try {
        for await (const event of new ClaudeRuntime(query, ENV).execute(
          request({ signal: abort.signal }),
        )) {
          events.push(event);
          if (event.type === 'text') abort.abort();
        }
      } catch (caught) {
        error = caught;
      }

      expect(events.map((event) => event.type)).toEqual(['session', 'text']);
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).toMatchObject({ kind: 'cancelled' });
      expect(sdkSignal!.aborted).toBe(true);
    });

    it('stops Claude Code when the caller stops reading early', async () => {
      let sdkSignal: AbortSignal | undefined;
      const { query } = fakeQuery(async function* (options) {
        sdkSignal = options.abortController!.signal;
        yield init();
        yield assistant([{ type: 'text', text: 'Hi' }]);
        yield success('Hi');
      });

      for await (const event of new ClaudeRuntime(query, ENV).execute(
        request(),
      )) {
        if (event.type === 'session') break;
      }

      expect(sdkSignal!.aborted).toBe(true);
    });

    it('leaves a finished turn alone', async () => {
      let sdkSignal: AbortSignal | undefined;
      const { query } = fakeQuery(async function* (options) {
        sdkSignal = options.abortController!.signal;
        yield init();
        yield success('Hi');
      });

      await collect(new ClaudeRuntime(query, ENV).execute(request()));

      expect(sdkSignal!.aborted).toBe(false);
    });
  });

  describe('failures', () => {
    it("explains an early exit with Claude Code's last output", async () => {
      const { query } = fakeQuery(async function* (options) {
        options.stderr!('Starting\n');
        options.stderr!('Error: Invalid model name: opus-9\n');
        yield* [];
        throw new Error('Claude Code process exited with code 1');
      });

      expect(
        await failure(new ClaudeRuntime(query, ENV).execute(request())),
      ).toMatchObject({
        kind: 'failed',
        message: 'Error: Invalid model name: opus-9',
      });
    });

    it('reports a signed-out turn without a session', async () => {
      const { query } = fakeQuery(async function* () {
        yield init();
        yield success('Not logged in · Please run /login', true);
      });
      const events: RuntimeEvent[] = [];

      const error = await failure(
        (async function* () {
          for await (const event of new ClaudeRuntime(query, ENV).execute(
            request(),
          )) {
            events.push(event);
            yield event;
          }
        })(),
      );

      expect(error).toMatchObject({ kind: 'auth' });
      expect(events).toEqual([]);
    });

    it('fails a turn that ends without a result', async () => {
      const { query } = fakeQuery(async function* () {
        yield init();
        yield assistant([{ type: 'text', text: 'Hi' }]);
      });

      expect(
        await failure(new ClaudeRuntime(query, ENV).execute(request())),
      ).toMatchObject({
        kind: 'failed',
        message: 'Claude Code stopped before finishing the turn',
      });
    });
  });
});

describe('summarize', () => {
  it('names the tool and what it would act on', () => {
    expect(summarize('Bash', { command: 'git   status\n' })).toBe(
      'Bash: git status',
    );
    expect(
      summarize('WebFetch', { url: 'https://example.com', prompt: 'x' }),
    ).toBe('WebFetch: https://example.com');
    expect(summarize('mcp__notes__search', { term: 'milk' })).toBe(
      'mcp__notes__search: {"term":"milk"}',
    );
  });

  it('shortens long input', () => {
    const line = summarize('Bash', { command: 'x'.repeat(500) });
    expect(line).toHaveLength('Bash: '.length + 200);
    expect(line.endsWith('…')).toBe(true);
  });
});
