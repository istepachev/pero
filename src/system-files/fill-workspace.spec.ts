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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultHostConfig } from '../config/host-config.js';
import { initWorkspace, SKELETON_NOTES } from '../config/workspace-skeleton.js';
import { fillWorkspace } from './fill-workspace.js';

describe('fillWorkspace', () => {
  let tmp: string;
  let home: string;
  let ws: string;
  let system: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-fill-')));
    home = join(tmp, 'home');
    ws = join(tmp, 'ws');
    system = join(ws, 'data', 'System');
    mkdirSync(home);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const read = (path: string) => readFileSync(join(ws, path), 'utf8');

  it('changes nothing in a whole workspace', async () => {
    initWorkspace(ws, home);
    await expect(fillWorkspace(ws, home)).resolves.toEqual([]);
  });

  it('writes a deleted system folder again', async () => {
    initWorkspace(ws, home);
    rmSync(system, { recursive: true });

    await expect(fillWorkspace(ws, home)).resolves.toEqual([
      { path: 'data/System/Pero.md', action: 'created' },
      { path: 'data/System/Workflows/', action: 'created' },
      { path: 'data/System/Persona.md', action: 'created' },
      { path: 'data/System/Instructions.md', action: 'created' },
      { path: 'data/System/Channels/Default.md', action: 'created' },
    ]);
    expect(read('data/System/Channels/Default.md')).toBe(
      SKELETON_NOTES['Channels/Default.md'],
    );
    expect(read('data/System/Pero.md')).toMatch(/^timezone: /m);
  });

  it('fills in each missing piece, keeping what is there', async () => {
    initWorkspace(ws, home);
    writeFileSync(join(system, 'Pero.md'), '---\nprovider: codex\n---\n');
    rmSync(join(system, 'Workflows'), { recursive: true });
    rmSync(join(system, 'Channels', 'Default.md'));
    rmSync(join(system, 'Instructions.md'));
    rmSync(join(ws, '.pero', 'config.yaml'));
    writeFileSync(join(ws, '.gitignore'), 'node_modules/\n');

    await expect(fillWorkspace(ws, home)).resolves.toEqual([
      { path: '.gitignore', action: 'updated' },
      { path: '.pero/config.yaml', action: 'created' },
      { path: 'data/System/Workflows/', action: 'created' },
      { path: 'data/System/Instructions.md', action: 'created' },
      { path: 'data/System/Channels/Default.md', action: 'created' },
    ]);
    expect(read('data/System/Pero.md')).toBe('---\nprovider: codex\n---\n');
    expect(read('.gitignore')).toBe('node_modules/\n.env\n');
    expect(read('.pero/config.yaml')).toBe(defaultHostConfig());
  });

  it('makes a workspace of a bare folder', async () => {
    mkdirSync(ws);
    const paths = (await fillWorkspace(ws, home)).map((entry) => entry.path);
    expect(paths).toEqual([
      '.gitignore',
      '.pero/config.yaml',
      'data/',
      'data/System/Pero.md',
      'data/System/Workflows/',
      'data/System/Persona.md',
      'data/System/Instructions.md',
      'data/System/Channels/Default.md',
    ]);
    expect(read('.pero/.gitignore')).toContain('!config.yaml');
  });

  it('writes Default.md unless a note of its name is anywhere', async () => {
    initWorkspace(ws, home);
    rmSync(join(system, 'Channels', 'Default.md'));
    mkdirSync(join(system, 'Channels', 'Home'));
    writeFileSync(join(system, 'Channels', 'Home', 'default.md'), 'Hi');
    await expect(fillWorkspace(ws, home)).resolves.toEqual([]);
  });

  it('leaves the system folder alone while config.yaml is invalid', async () => {
    initWorkspace(ws, home);
    rmSync(system, { recursive: true });
    writeFileSync(join(ws, '.pero', 'config.yaml'), 'data: [\n');
    await expect(fillWorkspace(ws, home)).resolves.toEqual([]);
  });

  it('creates no data folder config.yaml names, nor anything in it', async () => {
    initWorkspace(ws, home);
    writeFileSync(join(ws, '.pero', 'config.yaml'), 'data: Vault\n');
    await expect(fillWorkspace(ws, home)).resolves.toEqual([]);
    expect(existsSync(join(ws, 'Vault'))).toBe(false);

    mkdirSync(join(ws, 'Vault'));
    const paths = (await fillWorkspace(ws, home)).map((entry) => entry.path);
    expect(paths).toEqual([
      'Vault/System/Pero.md',
      'Vault/System/Workflows/',
      'Vault/System/Persona.md',
      'Vault/System/Instructions.md',
      'Vault/System/Channels/Default.md',
    ]);
  });
});
