import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NoWorkspaceError,
  resolveBootstrapConfig,
} from '../../config/bootstrap-config.js';
import type { Provider } from '../../config/provider-options.js';
import { initWorkspace } from '../../config/workspace-skeleton.js';
import type { Exec, ExecOutcome } from '../../providers/provider-auth.js';
import type { Prompts } from '../prompts.js';
import { configOrNewWorkspace } from './first-run.js';

type CliState = 'missing' | 'signed-out' | 'signed-in';

/** Provider CLIs in `states`, answering as Claude Code and Codex do. */
function fakeClis(states: Record<Provider, CliState>): Exec {
  return (command) => {
    const provider = command as Provider;
    const state = states[provider];
    const outcome = (): ExecOutcome => {
      if (state === 'missing') {
        return {
          code: null,
          stdout: '',
          error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
        };
      }
      const signedIn = state === 'signed-in';
      return provider === 'claude'
        ? {
            code: signedIn ? 0 : 1,
            stdout: JSON.stringify({ loggedIn: signedIn }),
          }
        : {
            code: signedIn ? 0 : 1,
            stdout: '',
            stderr: signedIn ? 'Logged in using ChatGPT' : 'Not logged in',
          };
    };
    return Promise.resolve(outcome());
  };
}

describe('configOrNewWorkspace', () => {
  let tmp: string;
  let home: string;
  const printed: string[] = [];

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-first-run-')));
    home = join(tmp, 'home');
    mkdirSync(home);
    printed.length = 0;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function run(options: {
    cwd: string;
    interactive: boolean;
    answer?: boolean;
    clis?: Record<Provider, CliState>;
    pick?: Provider;
    inputs?: string[];
    checkProviders?: boolean;
  }) {
    const confirm = vi.fn(() => Promise.resolve(options.answer ?? true));
    const select = vi.fn(() => Promise.resolve(options.pick ?? 'claude'));
    const inputs = [...(options.inputs ?? [])];
    const input = vi.fn(() => Promise.resolve(inputs.shift() ?? 'q'));
    const prompts = { confirm, select, input } as unknown as Prompts;
    const clis = {
      ...(options.clis ?? { claude: 'signed-in', codex: 'missing' }),
    };
    const result = configOrNewWorkspace({
      config: () =>
        resolveBootstrapConfig({ env: {}, cwd: options.cwd, homeDir: home }),
      interactive: options.interactive,
      prompts: () => Promise.resolve(prompts),
      print: (text) => printed.push(text),
      home,
      exec: (command, args, opts) => fakeClis(clis)(command, args, opts),
      ...(options.checkProviders === undefined
        ? {}
        : { checkProviders: options.checkProviders }),
    });
    return { result, confirm, select, input, clis };
  }

  const peroNote = (workspace: string) =>
    readFileSync(join(workspace, 'data', 'Settings', 'Pero.md'), 'utf8');

  it('makes ~/workspace when started from home and asked', async () => {
    const { result, confirm } = run({ cwd: home, interactive: true });

    await expect(result).resolves.toMatchObject({
      config: {
        workspace: join(home, 'workspace'),
        stateDir: join(home, 'workspace', '.pero'),
      },
      firstRun: true,
    });
    expect(confirm).toHaveBeenCalledWith({
      message: `No Pero workspace found. Create one in ${join(home, 'workspace')}?`,
      initial: true,
    });
    expect(existsSync(join(home, 'workspace', '.pero', 'config.yaml'))).toBe(
      true,
    );
    expect(printed).toContain('Provider: claude (Codex CLI not found)');
    const init = printed.find((text) => text.startsWith('Pero workspace'));
    expect(init).toContain(`Pero workspace ${join(home, 'workspace')}:`);
    expect(init).not.toContain('pero run');
    expect(peroNote(join(home, 'workspace'))).toMatch(
      /^provider: claude +# claude or codex$/m,
    );
  });

  it('makes the current folder a workspace from anywhere else', async () => {
    const here = join(tmp, 'notes');
    mkdirSync(here);

    await expect(
      run({ cwd: here, interactive: true }).result,
    ).resolves.toMatchObject({ config: { workspace: here } });
  });

  it('stops with the pero init to run when declined or not on a terminal', async () => {
    await expect(
      run({ cwd: home, interactive: true, answer: false }).result,
    ).rejects.toThrow(NoWorkspaceError);
    const { result, confirm } = run({ cwd: home, interactive: false });
    await expect(result).rejects.toThrow(
      `Create one with: pero init ${join(home, 'workspace')}`,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'workspace'))).toBe(false);
  });

  it('asks the owner to pick when both CLIs are installed', async () => {
    const { result, select } = run({
      cwd: home,
      interactive: true,
      clis: { claude: 'signed-out', codex: 'signed-in' },
      pick: 'codex',
    });

    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(select).toHaveBeenCalledWith({
      message: 'Which provider should your Agents use?',
      choices: [
        { value: 'claude', name: 'claude — Claude Code CLI, not signed in' },
        { value: 'codex', name: 'codex — Codex CLI, signed in' },
      ],
      initial: 'codex',
    });
    expect(printed).toContain('codex: Logged in using ChatGPT');
    expect(peroNote(join(home, 'workspace'))).toMatch(
      /^provider: codex +# claude or codex$/m,
    );
  });

  it('refuses, making nothing, when no provider CLI is installed', async () => {
    const { result, select } = run({
      cwd: home,
      interactive: true,
      clis: { claude: 'missing', codex: 'missing' },
    });

    await expect(result).rejects.toThrow(
      /neither CLI was found[\s\S]*npm install -g @anthropic-ai\/claude-code[\s\S]*npm install -g @openai\/codex/,
    );
    expect(select).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'workspace'))).toBe(false);
  });

  it('waits for sign-in, and refuses when the owner quits', async () => {
    const quit = run({
      cwd: home,
      interactive: true,
      clis: { claude: 'signed-out', codex: 'missing' },
      inputs: ['q'],
    });
    await expect(quit.result).rejects.toThrow(
      'Pero needs a signed-in provider. Run claude auth login, then pero run again.',
    );
    expect(printed).toContain('claude: Not signed in — run claude auth login');
    expect(existsSync(join(home, 'workspace'))).toBe(false);

    const later = run({
      cwd: home,
      interactive: true,
      clis: { claude: 'signed-out', codex: 'missing' },
      inputs: [''],
    });
    later.input.mockImplementationOnce(() => {
      later.clis.claude = 'signed-in';
      return Promise.resolve('');
    });
    await expect(later.result).resolves.toMatchObject({ firstRun: true });
    expect(later.input).toHaveBeenCalledTimes(1);
  });

  it('keeps the provider Pero.md sets, checking its sign-in', async () => {
    const ws = join(tmp, 'ws');
    initWorkspace(ws, home);
    const note = join(ws, 'data', 'Settings', 'Pero.md');
    writeFileSync(note, '---\nprovider: codex\n---\nBe brief.\n');

    const { result, select } = run({
      cwd: ws,
      interactive: true,
      clis: { claude: 'signed-in', codex: 'signed-in' },
    });
    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(select).not.toHaveBeenCalled();
    expect(printed).toContain('Provider: codex, as Pero.md sets it');
    expect(readFileSync(note, 'utf8')).toBe(
      '---\nprovider: codex\n---\nBe brief.\n',
    );

    const missing = run({
      cwd: ws,
      interactive: true,
      clis: { claude: 'signed-in', codex: 'missing' },
    });
    await expect(missing.result).rejects.toThrow(
      'Pero.md sets provider: codex, but the Codex CLI was not found',
    );
  });

  it('asks nothing once the workspace has a database, or off a terminal', async () => {
    const ws = join(tmp, 'ws');
    initWorkspace(ws, home);
    const offTerminal = run({ cwd: ws, interactive: false });
    await expect(offTerminal.result).resolves.toMatchObject({
      config: { workspace: ws },
      firstRun: false,
    });

    writeFileSync(join(ws, '.pero', 'pero.sqlite'), '');
    const { result, confirm, select } = run({
      cwd: ws,
      interactive: true,
      clis: { claude: 'missing', codex: 'missing' },
    });
    await expect(result).resolves.toMatchObject({ firstRun: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('settles no provider for the echo runtime', async () => {
    const { result } = run({
      cwd: home,
      interactive: true,
      clis: { claude: 'missing', codex: 'missing' },
      checkProviders: false,
    });

    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(peroNote(join(home, 'workspace'))).toMatch(/^# provider: claude/m);
  });
});
