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
import type { PermissionMode } from '../../config/tool-policy.js';
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
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  function run(options: {
    cwd: string;
    interactive: boolean;
    answer?: boolean;
    clis?: Record<Provider, CliState>;
    pick?: Provider;
    /** The permission mode picked; the one selected first when not given. */
    permissions?: PermissionMode;
    /** Whether Pero runs as root. */
    root?: boolean;
    /** The data folder picked; the one selected first when not given. */
    folder?: string;
    inputs?: string[];
    checkProviders?: boolean;
  }) {
    const confirm = vi.fn(() => Promise.resolve(options.answer ?? true));
    const select = vi.fn((question: { message: string; initial?: string }) =>
      Promise.resolve(
        question.message.includes('vault')
          ? (options.folder ?? question.initial)
          : question.message.includes('approve')
            ? (options.permissions ?? question.initial)
            : (options.pick ?? 'claude'),
      ),
    );
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
      root: options.root ?? false,
      ...(options.checkProviders === undefined
        ? {}
        : { checkProviders: options.checkProviders }),
    });
    return { result, confirm, select, input, clis };
  }

  const peroNote = (workspace: string, data = 'data') =>
    readFileSync(join(workspace, data, 'System', 'Pero.md'), 'utf8');

  /** The questions `select` was asked, by message. */
  const asked = (select: { mock: { calls: unknown[][] } }) =>
    select.mock.calls.map(
      ([question]) => (question as { message: string }).message,
    );

  const PROVIDER_QUESTION = 'Which provider should Pero use?';
  const PERMISSIONS_QUESTION = 'How should Pero approve its tools by default?';

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

  it('picks the data folder among the folders there, data/ first', async () => {
    const here = join(tmp, 'notes');
    for (const name of ['data', 'Journal', 'archive', '.git']) {
      mkdirSync(join(here, name), { recursive: true });
    }
    writeFileSync(join(here, 'README.md'), '');

    const { result, select } = run({ cwd: here, interactive: true });
    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(select).toHaveBeenCalledWith({
      message: 'Which folder is the vault Pero keeps notes in?',
      choices: [
        { value: 'archive', name: 'archive/' },
        { value: 'data', name: 'data/' },
        { value: 'Journal', name: 'Journal/' },
        { value: '/new', name: 'Create a new folder…' },
      ],
      initial: 'data',
    });
    expect(readFileSync(join(here, '.pero', 'config.yaml'), 'utf8')).toMatch(
      /^data: data$/m,
    );
  });

  it('offers to create data/ when it is missing, and keeps the pick', async () => {
    const here = join(tmp, 'notes');
    mkdirSync(join(here, 'Vault'), { recursive: true });

    const { result, select } = run({
      cwd: here,
      interactive: true,
      folder: 'Vault',
    });
    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(select).toHaveBeenCalledWith({
      message: 'Which folder is the vault Pero keeps notes in?',
      choices: [
        { value: 'data', name: 'Create data/' },
        { value: 'Vault', name: 'Vault/' },
        { value: '/new', name: 'Create a new folder…' },
      ],
      initial: 'data',
    });
    const config = readFileSync(join(here, '.pero', 'config.yaml'), 'utf8');
    expect(config).toMatch(/^data: Vault$/m);
    expect(config).toMatch(/^# system: Vault\/System$/m);
    expect(existsSync(join(here, 'data'))).toBe(false);
    expect(peroNote(here, 'Vault')).toMatch(
      /^provider: claude +# claude or codex$/m,
    );
  });

  it('creates a new data folder the owner names', async () => {
    const here = join(tmp, 'notes');
    mkdirSync(join(here, 'Journal'), { recursive: true });
    writeFileSync(join(here, 'README.md'), '');

    const { result, input } = run({
      cwd: here,
      interactive: true,
      folder: '/new',
      inputs: ['', 'a/b', '.hidden', 'README.md', ' Notes '],
    });
    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(input).toHaveBeenCalledWith({ message: 'Name of the new folder' });
    expect(input).toHaveBeenCalledTimes(5);
    expect(printed).toEqual(
      expect.arrayContaining([
        'Type a folder name.',
        'a/b is not a folder name; type one without / or \\.',
        '.hidden would be a hidden folder; type a name not starting with a dot.',
        `README.md is a file in ${here}; type another name.`,
      ]),
    );
    expect(readFileSync(join(here, '.pero', 'config.yaml'), 'utf8')).toMatch(
      /^data: Notes$/m,
    );
    expect(existsSync(join(here, 'data'))).toBe(false);
    expect(peroNote(here, 'Notes')).toMatch(
      /^provider: claude +# claude or codex$/m,
    );
  });

  it('asks no data folder of a workspace that has its config.yaml', async () => {
    const ws = join(tmp, 'ws');
    initWorkspace(ws, home);
    mkdirSync(join(ws, 'Vault'));

    const { result, select } = run({ cwd: ws, interactive: true });
    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(asked(select)).toEqual([PERMISSIONS_QUESTION]);
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
      message: 'Which provider should Pero use?',
      choices: [
        { value: 'claude', name: 'claude — Claude Code CLI, not signed in' },
        { value: 'codex', name: 'codex — Codex CLI, signed in' },
      ],
      initial: 'codex',
    });
    expect(printed).toContain('codex: Signed in (ChatGPT)');
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
    const note = join(ws, 'data', 'System', 'Pero.md');
    writeFileSync(
      note,
      '---\nprovider: codex\npermissions: bypass\n---\nBe brief.\n',
    );

    const { result, select } = run({
      cwd: ws,
      interactive: true,
      clis: { claude: 'signed-in', codex: 'signed-in' },
    });
    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(select).not.toHaveBeenCalled();
    expect(printed).toContain('Provider: codex, as Pero.md sets it');
    expect(printed).toContain('Permissions: bypass, as Pero.md sets it');
    expect(readFileSync(note, 'utf8')).toBe(
      '---\nprovider: codex\npermissions: bypass\n---\nBe brief.\n',
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

  it('writes the provider into a whole Pero.md when it is missing', async () => {
    const ws = join(tmp, 'ws');
    initWorkspace(ws, home);
    const note = join(ws, 'data', 'System', 'Pero.md');
    rmSync(note);

    const { result } = run({
      cwd: ws,
      interactive: true,
      clis: { claude: 'signed-in', codex: 'missing' },
    });
    await expect(result).resolves.toMatchObject({ firstRun: true });
    const text = readFileSync(note, 'utf8');
    expect(text).toMatch(/^provider: claude /m);
    expect(text).toMatch(/^timezone: /m);
    expect(text).toMatch(/^max-concurrent-runs: 2$/m);
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
    expect(peroNote(ws)).toMatch(/^provider: +# claude/m);
  });

  it('settles the provider again when Pero.md is gone from a workspace with a database', async () => {
    const ws = join(tmp, 'ws');
    initWorkspace(ws, home);
    writeFileSync(join(ws, '.pero', 'pero.sqlite'), '');
    const note = join(ws, 'data', 'System', 'Pero.md');

    rmSync(note);
    const one = run({
      cwd: ws,
      interactive: true,
      clis: { claude: 'signed-in', codex: 'missing' },
    });
    await expect(one.result).resolves.toMatchObject({ firstRun: false });
    expect(asked(one.select)).toEqual([PERMISSIONS_QUESTION]);
    expect(peroNote(ws)).toMatch(/^provider: claude /m);
    expect(peroNote(ws)).toMatch(/^permissions: ask /m);
    expect(peroNote(ws)).toMatch(/^max-concurrent-runs: 2$/m);

    rmSync(note);
    const both = run({
      cwd: ws,
      interactive: true,
      clis: { claude: 'signed-in', codex: 'signed-in' },
      pick: 'codex',
      permissions: 'bypass',
    });
    await expect(both.result).resolves.toMatchObject({ firstRun: false });
    expect(asked(both.select)).toEqual([
      PROVIDER_QUESTION,
      PERMISSIONS_QUESTION,
    ]);
    expect(peroNote(ws)).toMatch(/^provider: codex /m);
    expect(peroNote(ws)).toMatch(/^permissions: bypass /m);
  });

  it('leaves a missing Pero.md to pero run off a terminal or with its vault not mounted', async () => {
    const ws = join(tmp, 'ws');
    initWorkspace(ws, home);
    writeFileSync(join(ws, '.pero', 'pero.sqlite'), '');
    rmSync(join(ws, 'data', 'System', 'Pero.md'));

    const offTerminal = run({ cwd: ws, interactive: false });
    await expect(offTerminal.result).resolves.toMatchObject({
      firstRun: false,
    });
    expect(existsSync(join(ws, 'data', 'System', 'Pero.md'))).toBe(false);

    writeFileSync(join(ws, '.pero', 'config.yaml'), 'data: Vault\n');
    const unmounted = run({ cwd: ws, interactive: true });
    await expect(unmounted.result).resolves.toMatchObject({ firstRun: false });
    expect(unmounted.select).not.toHaveBeenCalled();
    expect(existsSync(join(ws, 'Vault'))).toBe(false);
  });

  it('asks the default permission mode, ask selected first, and writes it', async () => {
    const { result, select } = run({
      cwd: home,
      interactive: true,
      permissions: 'bypass',
    });

    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(select).toHaveBeenCalledWith({
      message: PERMISSIONS_QUESTION,
      choices: [
        {
          value: 'ask',
          name: 'ask — edits in its folder run freely; anything else asks you in Telegram (recommended)',
        },
        {
          value: 'bypass',
          name: 'bypass — every tool runs without asking, like claude --dangerously-skip-permissions',
        },
      ],
      initial: 'ask',
    });
    const note = join(home, 'workspace', 'data', 'System', 'Pero.md');
    expect(peroNote(join(home, 'workspace'))).toMatch(
      /^permissions: bypass +# ask or bypass$/m,
    );
    expect(printed).toContain(
      `Pero.md now sets provider: claude, permissions: bypass; change them in ${note}`,
    );
    expect(printed.join('\n')).not.toContain('IS_SANDBOX');
  });

  it('describes the permission modes as Codex applies them', async () => {
    const { result, select } = run({
      cwd: home,
      interactive: true,
      clis: { claude: 'missing', codex: 'signed-in' },
    });

    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: PERMISSIONS_QUESTION,
        choices: [
          {
            value: 'ask',
            name: 'ask — Codex sandbox: writes and runs commands only in its folder, without network (recommended)',
          },
          {
            value: 'bypass',
            name: 'bypass — no sandbox, like codex --dangerously-bypass-approvals-and-sandbox',
          },
        ],
      }),
    );
    expect(peroNote(join(home, 'workspace'))).toMatch(/^permissions: ask /m);
  });

  it('warns that Claude Code refuses bypass as root, unless IS_SANDBOX=1', async () => {
    vi.stubEnv('IS_SANDBOX', '');
    const { result } = run({
      cwd: home,
      interactive: true,
      permissions: 'bypass',
      root: true,
    });

    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(printed).toContain(
      'Claude Code refuses bypass when it runs as root unless IS_SANDBOX=1 is set; run Pero as an ordinary account.',
    );

    rmSync(join(home, 'workspace'), { recursive: true });
    printed.length = 0;
    vi.stubEnv('IS_SANDBOX', '1');
    const sandbox = run({
      cwd: home,
      interactive: true,
      permissions: 'bypass',
      root: true,
    });
    await expect(sandbox.result).resolves.toMatchObject({ firstRun: true });
    expect(printed.join('\n')).not.toContain('IS_SANDBOX');
  });

  it('settles no provider for the echo runtime', async () => {
    const { result } = run({
      cwd: home,
      interactive: true,
      clis: { claude: 'missing', codex: 'missing' },
      checkProviders: false,
    });

    await expect(result).resolves.toMatchObject({ firstRun: true });
    expect(peroNote(join(home, 'workspace'))).toMatch(/^provider: +# claude/m);
    expect(peroNote(join(home, 'workspace'))).toMatch(/^permissions: +# ask/m);
  });
});
