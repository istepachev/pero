import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNote } from '../settings-files/note.js';
import { readAgentNote, readPeroNote } from '../settings-files/schemas.js';
import { STATE_GITIGNORE } from './workspace-layout.js';
import { defaultHostConfig, readHostConfig } from './host-config.js';
import { initWorkspace, WorkspaceInitError } from './workspace-skeleton.js';

describe('initWorkspace', () => {
  let tmp: string;
  let home: string;
  let dir: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-init-')));
    home = join(tmp, 'home');
    dir = join(home, 'workspace');
    mkdirSync(home);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const read = (path: string) => readFileSync(join(dir, path), 'utf8');

  it('writes the skeleton of a new workspace', () => {
    const { workspace, entries } = initWorkspace(dir, home);

    expect(workspace).toBe(dir);
    expect(entries).toEqual([
      { path: '.gitignore', action: 'created' },
      { path: '.pero/.gitignore', action: 'created' },
      { path: '.pero/config.yaml', action: 'created' },
      { path: 'data/Settings/Pero.md', action: 'created' },
      { path: 'data/Settings/Agents/Main.md', action: 'created' },
      { path: 'data/Settings/Agents/_Template.md', action: 'created' },
      { path: 'data/Settings/Workflows/', action: 'created' },
    ]);
    expect(read('.gitignore')).toBe('.env\n');
    expect(read('.pero/.gitignore')).toBe(STATE_GITIGNORE);
    expect(read('.pero/config.yaml')).toBe(defaultHostConfig());
    expect(statSync(join(dir, '.pero')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, 'data/Settings/Workflows'))).toEqual([]);
  });

  it('changes nothing the second time', () => {
    initWorkspace(dir, home);
    const before = read('data/Settings/Pero.md');

    const { entries } = initWorkspace(dir, home);

    expect(entries.every((entry) => entry.action === 'kept')).toBe(true);
    expect(read('data/Settings/Pero.md')).toBe(before);
  });

  it('fills in only what a cloned workspace is missing', () => {
    mkdirSync(join(dir, '.pero'), { recursive: true });
    mkdirSync(join(dir, 'vault', 'Settings', 'Agents'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'node_modules/');
    writeFileSync(join(dir, '.pero', 'config.yaml'), 'data: vault\n');
    writeFileSync(
      join(dir, 'vault', 'Settings', 'Agents', 'Main.md'),
      'Mine.\n',
    );

    const { entries } = initWorkspace(dir, home);

    expect(entries).toEqual([
      { path: '.gitignore', action: 'updated' },
      { path: '.pero/.gitignore', action: 'created' },
      { path: '.pero/config.yaml', action: 'kept' },
      { path: 'vault/Settings/Pero.md', action: 'created' },
      { path: 'vault/Settings/Agents/Main.md', action: 'kept' },
      { path: 'vault/Settings/Agents/_Template.md', action: 'created' },
      { path: 'vault/Settings/Workflows/', action: 'created' },
    ]);
    expect(read('.gitignore')).toBe('node_modules/\n.env\n');
    expect(read('.pero/config.yaml')).toBe('data: vault\n');
    expect(read('vault/Settings/Agents/Main.md')).toBe('Mine.\n');
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });

  it('puts the notes where config.yaml names the settings folder', () => {
    mkdirSync(join(dir, '.pero'), { recursive: true });
    writeFileSync(join(dir, '.pero', 'config.yaml'), 'settings: pero\n');

    initWorkspace(dir, home);

    expect(existsSync(join(dir, 'pero', 'Pero.md'))).toBe(true);
    expect(readHostConfig(join(dir, '.pero', 'config.yaml'))?.settings).toBe(
      'pero',
    );
  });

  it('writes notes the settings loader reads, with every default', () => {
    initWorkspace(dir, home);

    for (const [file, readNote] of [
      ['data/Settings/Pero.md', readPeroNote],
      ['data/Settings/Agents/Main.md', readAgentNote],
      ['data/Settings/Agents/_Template.md', readAgentNote],
    ] as const) {
      const parsed = parseNote(file, read(file));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      expect(parsed.note.properties, file).toEqual({});
      expect(readNote(file, parsed.note).ok, file).toBe(true);
    }
  });

  it('refuses the home folder', () => {
    expect(() => initWorkspace(home, home)).toThrow(WorkspaceInitError);
    expect(() => initWorkspace(home, home)).toThrow(
      `${home} is your home folder, which can't be a workspace: every folder under it would find it. Use a folder of its own, such as ~/workspace.`,
    );
  });
});
