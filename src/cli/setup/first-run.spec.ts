import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NoWorkspaceError,
  resolveBootstrapConfig,
} from '../../config/bootstrap-config.js';
import type { Prompts } from '../prompts.js';
import { configOrNewWorkspace } from './first-run.js';

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
  }) {
    const confirm = vi.fn(() => Promise.resolve(options.answer ?? true));
    const prompts = { confirm } as unknown as Prompts;
    const result = configOrNewWorkspace({
      config: () =>
        resolveBootstrapConfig({ env: {}, cwd: options.cwd, homeDir: home }),
      interactive: options.interactive,
      prompts: () => Promise.resolve(prompts),
      print: (text) => printed.push(text),
      home,
    });
    return { result, confirm };
  }

  it('makes ~/workspace when started from home and asked', async () => {
    const { result, confirm } = run({ cwd: home, interactive: true });

    await expect(result).resolves.toMatchObject({
      workspace: join(home, 'workspace'),
      stateDir: join(home, 'workspace', '.pero'),
    });
    expect(confirm).toHaveBeenCalledWith({
      message: `No Pero workspace found. Create one in ${join(home, 'workspace')}?`,
      initial: true,
    });
    expect(existsSync(join(home, 'workspace', '.pero', 'config.yaml'))).toBe(
      true,
    );
    expect(printed[0]).toContain(`Pero workspace ${join(home, 'workspace')}:`);
    expect(printed[0]).not.toContain('pero run');
  });

  it('makes the current folder a workspace from anywhere else', async () => {
    const here = join(tmp, 'notes');
    mkdirSync(here);

    await expect(
      run({ cwd: here, interactive: true }).result,
    ).resolves.toMatchObject({ workspace: here });
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

  it('asks nothing when a workspace is found', async () => {
    mkdirSync(join(tmp, 'ws', '.pero'), { recursive: true });
    const { result, confirm } = run({
      cwd: join(tmp, 'ws'),
      interactive: true,
    });

    await expect(result).resolves.toMatchObject({ workspace: join(tmp, 'ws') });
    expect(confirm).not.toHaveBeenCalled();
  });
});
