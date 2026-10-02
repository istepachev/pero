import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editDecision } from './edit-policy.js';

describe('editDecision', () => {
  let tmp: string;
  let vault: string;
  let system: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-edit-policy-'));
    vault = join(tmp, 'data');
    system = join(vault, 'System');
    mkdirSync(join(system, 'Agents'), { recursive: true });
    writeFileSync(join(system, 'Agents', 'Health.md'), 'Be kind.');
    writeFileSync(join(vault, 'Groceries.md'), '- milk');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function decide(
    tool: string,
    input: Record<string, unknown>,
    workingDirectory = vault,
  ) {
    return editDecision(tool, input, {
      workingDirectory,
      systemFolder: system,
    });
  }

  it('allows edits in the folder', async () => {
    expect(
      await decide('Edit', { file_path: join(vault, 'Groceries.md') }),
    ).toBe('allow');
    expect(
      await decide('Write', { file_path: join(vault, 'Trips', 'Rome.md') }),
    ).toBe('allow');
    expect(await decide('Write', { file_path: 'Journal.md' })).toBe('allow');
    expect(
      await decide('NotebookEdit', { notebook_path: join(vault, 'a.ipynb') }),
    ).toBe('allow');
  });

  it('marks edits under the system folder, however the path is written', async () => {
    const health = join(system, 'Agents', 'Health.md');

    for (const file_path of [
      health,
      'System/Agents/Health.md',
      join(vault, 'Trips', '..', 'System', 'Agents', 'Health.md'),
      '../data/System/Agents/Health.md',
      join(system, 'Workflows', 'Weekly.md'),
      system,
    ]) {
      expect(await decide('Edit', { file_path }), file_path).toBe('system');
    }
    expect(await decide('MultiEdit', { file_path: health, edits: [] })).toBe(
      'system',
    );
  });

  it('marks edits through a symlink into the system folder', async () => {
    symlinkSync(join(system, 'Agents'), join(vault, 'Agents'));
    symlinkSync(
      join(system, 'Agents', 'Health.md'),
      join(vault, 'Health link.md'),
    );

    expect(
      await decide('Edit', { file_path: join(vault, 'Agents', 'Health.md') }),
    ).toBe('system');
    expect(
      await decide('Write', { file_path: join(vault, 'Agents', 'New.md') }),
    ).toBe('system');
    expect(
      await decide('Edit', { file_path: join(vault, 'Health link.md') }),
    ).toBe('system');
  });

  it('follows a working folder or system folder reached through a symlink', async () => {
    const link = join(tmp, 'vault-link');
    symlinkSync(vault, link);

    expect(
      await decide('Edit', { file_path: join(link, 'Groceries.md') }),
    ).toBe('allow');
    expect(
      await decide('Edit', { file_path: join(vault, 'Groceries.md') }, link),
    ).toBe('allow');
    expect(
      await decide(
        'Edit',
        { file_path: join(link, 'System', 'Agents', 'Health.md') },
        link,
      ),
    ).toBe('system');
  });

  it('asks about edits outside the folder', async () => {
    mkdirSync(join(tmp, 'elsewhere'));

    expect(
      await decide('Edit', { file_path: join(tmp, 'elsewhere', 'x.md') }),
    ).toBe('ask');
    expect(await decide('Write', { file_path: '../outside.md' })).toBe('ask');
    expect(await decide('Write', { file_path: '~/notes.md' })).toBe('ask');
  });

  it("asks about Claude Code's, Git's, Pero's, and the shell's own files in the folder", async () => {
    for (const file_path of [
      '.claude/settings.local.json',
      '.git/hooks/pre-commit',
      'project/.vscode/tasks.json',
      '.mcp.json',
      'sub/.bashrc',
      '.pero/config.yaml',
      '.env',
    ]) {
      expect(await decide('Write', { file_path }), file_path).toBe('ask');
    }
    expect(await decide('Write', { file_path: 'claude.md' })).toBe('allow');
  });

  it('asks about other tools and edits without a path', async () => {
    expect(await decide('Bash', { command: 'touch x' })).toBe('ask');
    expect(await decide('Read', { file_path: join(vault, 'x.md') })).toBe(
      'ask',
    );
    expect(await decide('Edit', {})).toBe('ask');
    expect(await decide('Edit', { file_path: 3 })).toBe('ask');
  });

  it('asks when the path cannot be resolved', async () => {
    expect(
      await decide('Write', {
        file_path: join(vault, 'Groceries.md', 'inside-a-file.md'),
      }),
    ).toBe('ask');
  });

  it('protects nothing without a system folder', async () => {
    expect(
      await editDecision(
        'Edit',
        { file_path: join(system, 'Agents', 'Health.md') },
        { workingDirectory: vault },
      ),
    ).toBe('allow');
  });

  describe("Pero's guide", () => {
    let guide: string;

    beforeEach(() => {
      mkdirSync(join(tmp, '.pero'));
      guide = join(tmp, '.pero', 'guide.md');
      writeFileSync(guide, '# Pero guide');
    });

    function read(file_path: unknown, workingDirectory = vault) {
      return editDecision(
        'Read',
        { file_path },
        { workingDirectory, systemFolder: system, guideFile: guide },
      );
    }

    it('is read without asking, from any folder and however the path is written', async () => {
      expect(await read(guide)).toBe('allow');
      expect(await read('../.pero/guide.md')).toBe('allow');
      expect(await read(guide, join(system, 'Agents'))).toBe('allow');
      symlinkSync(join(tmp, '.pero'), join(vault, 'pero-link'));
      expect(await read(join(vault, 'pero-link', 'guide.md'))).toBe('allow');
    });

    it('allows reading nothing else, nor editing it', async () => {
      expect(await read(join(tmp, '.pero', 'config.yaml'))).toBe('ask');
      expect(await read(join(tmp, '.env'))).toBe('ask');
      expect(await read(undefined)).toBe('ask');
      expect(
        await editDecision(
          'Write',
          { file_path: guide },
          { workingDirectory: tmp, guideFile: guide },
        ),
      ).toBe('ask');
    });
  });
});
