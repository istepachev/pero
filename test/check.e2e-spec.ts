import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `npm run test:e2e` builds first.
const PERO = join(import.meta.dirname, '../bin/pero.js');

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('pero check (e2e)', { timeout: 60_000 }, () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pero-check-')));
    workspace = join(home, 'workspace');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Runs `pero` from `cwd` with `home` as the home folder. */
  function pero(args: string[], cwd = home): Promise<Result> {
    const {
      PERO_WORKSPACE: _workspace,
      PERO_TELEGRAM_BOT_TOKEN: _token,
      ...env
    } = process.env;
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [PERO, ...args],
        { env: { ...env, HOME: home }, cwd },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (error.code as number | null) : 0,
            stdout,
            stderr,
          });
        },
      );
    });
  }

  function write(path: string, text: string) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), text);
  }

  it('passes on a new workspace, found from inside it, and opens no database', async () => {
    expect((await pero(['init', workspace])).code).toBe(0);
    const result = await pero(['check'], join(workspace, 'data'));
    expect(result).toEqual({
      code: 0,
      stdout: [
        'Checked 1 Agent and 0 Workflows in data/System: no problems.',
        "Topic titles weren't checked against Telegram's topics, since Pero isn't running.",
        '',
      ].join('\n'),
      stderr: '',
    });
    expect(readdirSync(join(workspace, '.pero')).sort()).toEqual([
      '.gitignore',
      'config.yaml',
    ]);
  });

  it('lists every problem by file and exits 1', async () => {
    await pero(['init', workspace]);
    write('data/System/Agents/Health.md', '---\ntopic: Health\n---\nHi');
    write('data/System/Agents/Running.md', '---\ntopic: health\n---\nRun');
    write('data/System/Agents/Coach.md', '---\nmodle: sonnet\n---\nCoach');
    write(
      'data/System/Workflows/Weekly health report.md',
      '---\ntrigger: schedule\nday: sunday\nhour: 25\n---\nReport',
    );
    write('data/System/Workflows/Review.md', '---\nagent: Nobody\n---\nGo');
    write('data/System/Notes.md', 'Stray');

    const result = await pero(['-w', workspace, 'check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      [
        'data/System/Agents/Coach.md',
        '  modle: unknown property (did you mean model?)',
        'data/System/Agents/Health.md',
        '  topic: "Health" is also claimed by Agents/Running.md, so neither answers there',
        'data/System/Agents/Running.md',
        '  topic: "health" is also claimed by Agents/Health.md, so neither answers there',
        'data/System/Notes.md',
        '  not an Agent or Workflow note; move it under Agents/ or Workflows/, or start its name with _',
        'data/System/Workflows/Review.md',
        '  agent: no Agent note is named nobody',
        'data/System/Workflows/Weekly health report.md',
        '  trigger: unknown property',
        '  hour: must be a whole number from 0 to 23',
        '',
        '7 problems in 6 files.',
        "Topic titles weren't checked against Telegram's topics, since Pero isn't running.",
        '',
      ].join('\n'),
    );
  });

  it('prints JSON for tools', async () => {
    await pero(['init', workspace]);
    write('.pero/config.yaml', 'data: data\nbogus: 1\n');

    const result = await pero(['-w', workspace, 'check', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      systemFolder: null,
      agents: 0,
      workflows: 0,
      topicsChecked: false,
      problems: [
        {
          file: '.pero/config.yaml',
          property: null,
          message: 'line 2: bogus: unknown key',
        },
      ],
    });

    write('.pero/config.yaml', 'data: data\n');
    const clean = await pero(['-w', workspace, 'check', '--json']);
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, problems: [] });
  });

  it('suggests pero init when there is no workspace', async () => {
    const result = await pero(['check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Create one with: pero init');
  });
});
