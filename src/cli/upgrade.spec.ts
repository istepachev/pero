import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec, ExecOutcome } from '../providers/provider-auth.js';
import {
  compareVersions,
  installVersion,
  latestVersion,
  localNpm,
  requireGlobalInstall,
  versionOnDisk,
} from './upgrade.js';

/** Records each command and answers with `answer`'s outcome. */
function recorder(answer: (command: string, args: string[]) => ExecOutcome) {
  const calls: string[] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args].join(' '));
    return Promise.resolve(answer(command, args));
  };
  return { exec, calls };
}

describe('upgrade', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pero-upgrade-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A package folder holding `version`. */
  function writePackage(root: string, version: string): string {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    return root;
  }

  it('orders versions, with a prerelease before its release', () => {
    expect(compareVersions('0.16.0', '0.16.0')).toBe(0);
    expect(compareVersions('0.16.0', '0.17.0')).toBeLessThan(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.2.0-beta.2', '0.2.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('0.2.0-beta', '0.2.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('0.2.0-alpha.1', '0.2.0-beta.1')).toBeLessThan(0);
    expect(() => compareVersions('0.2', '0.2.0')).toThrow('Not a version: 0.2');
  });

  it('asks npm for the version the latest tag names', async () => {
    const { exec, calls } = recorder(() => ({ code: 0, stdout: '0.17.0\n' }));

    await expect(latestVersion('npm', exec)).resolves.toBe('0.17.0');
    expect(calls).toEqual(['npm view @perokit/pero@latest version']);
  });

  it('says why the latest version is unknown', async () => {
    const offline = recorder(() => ({
      code: 1,
      stdout: '',
      stderr: 'npm error code ENOTFOUND\n',
    }));
    await expect(latestVersion('npm', offline.exec)).rejects.toThrow(
      'Could not find the latest version of @perokit/pero: npm error code ENOTFOUND',
    );

    const odd = recorder(() => ({ code: 0, stdout: '' }));
    await expect(latestVersion('npm', odd.exec)).rejects.toThrow(
      'unexpected output from npm view',
    );
  });

  it('uses the npm beside node, or the one on PATH', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), '');
    expect(localNpm(join(bin, 'node'))).toBe('npm');
    writeFileSync(join(bin, 'npm'), '');
    expect(localNpm(join(bin, 'node'))).toBe(join(bin, 'npm'));
  });

  it('accepts only the package npm installed globally', async () => {
    const globalRoot = join(dir, 'lib', 'node_modules');
    const installed = writePackage(
      join(globalRoot, '@perokit', 'pero'),
      '0.16.0',
    );
    const { exec, calls } = recorder(() => ({
      code: 0,
      stdout: `${globalRoot}\n`,
    }));

    await expect(
      requireGlobalInstall('npm', exec, installed),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(['npm root -g']);

    const checkout = writePackage(join(dir, 'pero'), '0.16.0');
    await expect(requireGlobalInstall('npm', exec, checkout)).rejects.toThrow(
      `This pero runs from ${checkout}, not from npm's global packages (${installed})`,
    );
  });

  it('refuses a checkout npm link put among the global packages', async () => {
    const checkout = writePackage(join(dir, 'pero'), '0.16.0');
    const globalRoot = join(dir, 'lib', 'node_modules');
    mkdirSync(join(globalRoot, '@perokit'), { recursive: true });
    symlinkSync(checkout, join(globalRoot, '@perokit', 'pero'));
    const { exec } = recorder(() => ({ code: 0, stdout: globalRoot }));

    await expect(requireGlobalInstall('npm', exec, checkout)).rejects.toThrow(
      'git pull',
    );
  });

  it('installs the version globally, saying how when npm may not write', async () => {
    const { exec, calls } = recorder(() => ({ code: 0, stdout: '' }));
    await installVersion('/usr/bin/npm', exec, '0.17.0');
    expect(calls).toEqual(['/usr/bin/npm install -g @perokit/pero@0.17.0']);

    const denied = recorder(() => ({
      code: 243,
      stdout: '',
      stderr: 'npm error code EACCES\nnpm error syscall mkdir\n',
    }));
    await expect(installVersion('npm', denied.exec, '0.17.0')).rejects.toThrow(
      /failed:\nnpm error code EACCES[\s\S]*sudo npm install -g @perokit\/pero@0\.17\.0/,
    );
  });

  it('reads the version installed now', () => {
    const root = writePackage(join(dir, 'pero'), '0.16.0');
    expect(versionOnDisk(root)).toBe('0.16.0');
    writePackage(root, '0.17.0');
    expect(versionOnDisk(root)).toBe('0.17.0');
  });
});
