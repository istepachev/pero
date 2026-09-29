import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNotes, scanSettingsFolder } from './scan.js';

describe('scanSettingsFolder', () => {
  let root: string;
  let settings: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pero-scan-'));
    settings = join(root, 'Settings');
    await mkdir(settings);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(file: string, text: string, base = settings) {
    await mkdir(dirname(join(base, file)), { recursive: true });
    await writeFile(join(base, file), text);
  }

  it('finds notes in subfolders, sorted by path', async () => {
    await write('Pero.md', '---\nprovider: claude\n---');
    await write('Workflows/Weekly.md', 'Go');
    await write('Agents/Main.md', 'Hi');
    await write('Agents/Coaches/Running.md', 'Run');
    const entries = await scanSettingsFolder(settings);
    expect(entries.map((entry) => entry.file)).toEqual([
      'Agents/Coaches/Running.md',
      'Agents/Main.md',
      'Pero.md',
      'Workflows/Weekly.md',
    ]);
    expect(entries[2]).toEqual({
      file: 'Pero.md',
      size: 24,
      mtimeMs: expect.any(Number),
    });
  });

  it('reports size and modification time', async () => {
    await write('Agents/Main.md', 'Hello');
    const when = new Date('2026-01-02T03:04:05Z');
    await utimes(join(settings, 'Agents/Main.md'), when, when);
    expect(await scanSettingsFolder(settings)).toEqual([
      { file: 'Agents/Main.md', size: 5, mtimeMs: when.getTime() },
    ]);
  });

  it('skips ignored files and never enters ignored folders', async () => {
    await write('Agents/Main.md', 'Hi');
    await write('Agents/_Template.md', 'Template');
    await write('Agents/.Hidden.md', 'Hidden');
    await write('Agents/avatar.png', 'png');
    await write('_Drafts/Agents/Old.md', 'Old');
    await write('.obsidian/workspace.md', 'Obsidian');
    await write('.trash/Agents/Gone.md', 'Gone');
    expect(
      (await scanSettingsFolder(settings)).map((entry) => entry.file),
    ).toEqual(['Agents/Main.md']);
  });

  it('reads linked notes but does not enter linked folders', async () => {
    await write('Shared/Coach.md', 'Coach', root);
    await write('Agents/Main.md', 'Hi');
    await symlink(
      join(root, 'Shared/Coach.md'),
      join(settings, 'Agents/Coach.md'),
    );
    await symlink(join(root, 'Shared'), join(settings, 'Agents/Linked'));
    await symlink(
      join(root, 'missing.md'),
      join(settings, 'Agents/Dangling.md'),
    );
    expect(
      (await scanSettingsFolder(settings)).map((entry) => entry.file),
    ).toEqual(['Agents/Coach.md', 'Agents/Main.md']);
  });

  it('finds no notes in a missing folder', async () => {
    expect(await scanSettingsFolder(join(root, 'Missing'))).toEqual([]);
  });

  it('reads the notes, leaving out one removed since the scan', async () => {
    await write('Agents/Main.md', 'Hi');
    await write('Agents/Health.md', 'Coach');
    const entries = await scanSettingsFolder(settings);
    await rm(join(settings, 'Agents/Main.md'));
    expect(await readNotes(settings, entries)).toEqual([
      { file: 'Agents/Health.md', text: 'Coach' },
    ]);
  });

  it('scans 500 notes quickly', async () => {
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        write(`Agents/Group ${index % 10}/Agent ${index}.md`, `Agent ${index}`),
      ),
    );
    const started = performance.now();
    const entries = await scanSettingsFolder(settings);
    await readNotes(settings, entries);
    expect(entries).toHaveLength(500);
    // Generous, so a slow CI machine stays green; typically tens of ms.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
