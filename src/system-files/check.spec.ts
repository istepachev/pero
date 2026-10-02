import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../config/workspace-skeleton.js';
import { checkWorkspace } from './check.js';

describe('checkWorkspace', () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pero-check-')));
    workspace = join(home, 'workspace');
    initWorkspace(workspace, home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function write(path: string, text: string) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), text);
  }

  const check = () =>
    checkWorkspace({ workspace, homeDir: home, hostTimeZone: 'UTC' });

  it('passes on the pero init skeleton', async () => {
    expect(await check()).toEqual({
      systemFolder: 'data/System',
      agents: 1,
      workflows: 0,
      topicsChecked: false,
      problems: [],
    });
  });

  it('reports the notes’ problems by their path in the workspace', async () => {
    write('data/System/Agents/Coach.md', '---\nmodle: sonnet\n---\nCoach');
    write('data/System/Workflows/Weekly.md', '---\nday: sunday\n---\nGo');
    write('data/System/Workflows/Daily.md', '---\nhour: 9\n---\nGo');
    const result = await check();
    expect(result.problems).toEqual([
      {
        file: 'data/System/Agents/Coach.md',
        property: 'modle',
        message: 'unknown property (did you mean model?)',
      },
      {
        file: 'data/System/Workflows/Weekly.md',
        property: 'hour',
        message: 'must be set when day or minute is',
      },
    ]);
    expect(result).toMatchObject({ agents: 1, workflows: 1 });
  });

  it('finds the system folder where config.yaml says', async () => {
    write('.pero/config.yaml', 'data: vault\nsystem: pero-system\n');
    mkdirSync(join(workspace, 'vault'));
    write('pero-system/Agents/Main.md', '---\neffort: huge\n---');
    const result = await check();
    expect(result.systemFolder).toBe('pero-system');
    expect(result.problems).toEqual([
      expect.objectContaining({
        file: 'pero-system/Agents/Main.md',
        property: 'effort',
      }),
    ]);
  });

  it('shows a system folder outside the workspace by its full path', async () => {
    const outside = join(home, 'notes');
    write('.pero/config.yaml', `system: ${outside}\n`);
    mkdirSync(join(outside, 'Agents'), { recursive: true });
    writeFileSync(join(outside, 'Agents', 'Bad.md'), '---\nenabled: yes\n---');
    const result = await check();
    expect(result.systemFolder).toBe(outside);
    expect(result.problems).toEqual([
      {
        file: join(outside, 'Agents/Bad.md'),
        property: 'enabled',
        message: 'must be true or false',
      },
    ]);
  });

  it('reports an invalid config.yaml line by line, without the notes', async () => {
    write('.pero/config.yaml', 'data: [a]\nbogus: 1\n');
    write('data/System/Agents/Coach.md', '---\nmodle: x\n---');
    expect(await check()).toEqual({
      systemFolder: null,
      agents: 0,
      workflows: 0,
      topicsChecked: false,
      problems: [
        {
          file: '.pero/config.yaml',
          property: null,
          message: 'line 1: data: must be a folder path',
        },
        {
          file: '.pero/config.yaml',
          property: null,
          message: 'line 2: bogus: unknown key',
        },
      ],
    });
  });

  it('reports a data folder that does not exist, but not the default one', async () => {
    rmSync(join(workspace, 'data'), { recursive: true });
    expect((await check()).problems).toEqual([]);
    write('.pero/config.yaml', 'data: vault\n');
    expect((await check()).problems).toEqual([
      {
        file: '.pero/config.yaml',
        property: 'data',
        message: `Working directory ${join(workspace, 'vault')} does not exist`,
      },
    ]);
  });

  it('reports a .env others can read', async () => {
    write('.env', 'PERO_TELEGRAM_BOT_TOKEN=x\n');
    chmodSync(join(workspace, '.env'), 0o644);
    expect((await check()).problems).toEqual([
      {
        file: '.env',
        property: null,
        message: `readable by other users; run chmod 600 ${join(workspace, '.env')}`,
      },
    ]);
    chmodSync(join(workspace, '.env'), 0o600);
    expect((await check()).problems).toEqual([]);
  });

  it('reports a .env that Git tracks', async () => {
    execFileSync('git', ['init', '-q', workspace]);
    write('.env', 'PERO_TELEGRAM_BOT_TOKEN=x\n');
    chmodSync(join(workspace, '.env'), 0o600);
    expect((await check()).problems).toEqual([]);
    execFileSync('git', ['-C', workspace, 'add', '-f', '.env']);
    expect((await check()).problems).toEqual([
      {
        file: '.env',
        property: null,
        message: expect.stringMatching(/^\.env is tracked by Git/),
      },
    ]);
  });
});
