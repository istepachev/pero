import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceLayout } from '../config/workspace-layout.js';
import type { Exec, ExecOutcome } from '../providers/provider-auth.js';
import {
  detectServiceManager,
  installService,
  systemService,
  uninstallService,
} from './system-service.js';

/** Records each command and answers with `answer`'s outcome. */
function recorder(answer: (command: string, args: string[]) => ExecOutcome) {
  const calls: string[] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args].join(' '));
    return Promise.resolve(answer(command, args));
  };
  return { exec, calls };
}

const ok: ExecOutcome = { code: 0, stdout: '' };

describe('system service', () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pero-service-')));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const target = (workspace = '/home/ada/my workspace') => ({
    layout: workspaceLayout(workspace),
    home,
    node: '/usr/bin/node',
    cli: '/usr/lib/node_modules/@perokit/pero/bin/pero.js',
    path: '/home/ada/.local/bin:/usr/bin',
  });

  it('writes a systemd user unit that runs pero run --foreground', () => {
    const service = systemService('systemd', target('/srv/50%$off'));

    expect(service.file).toBe(
      join(home, '.config', 'systemd', 'user', 'pero.service'),
    );
    expect(service.name).toBe('systemd user service pero.service');
    expect(service.contents).toContain(
      'ExecStart="/usr/bin/node" "/usr/lib/node_modules/@perokit/pero/bin/pero.js" "run" "--foreground" "--workspace" "/srv/50%%$$off"\n',
    );
    expect(service.contents).toContain(
      'Environment="PATH=/home/ada/.local/bin:/usr/bin"\n',
    );
    expect(service.contents).toContain('Restart=on-failure\n');
    expect(service.contents).toContain('WantedBy=default.target\n');
    expect(
      systemService('systemd', { ...target(), configHome: '/xdg' }).file,
    ).toBe('/xdg/systemd/user/pero.service');
  });

  it('writes a launchd agent that keeps Pero alive after a crash', () => {
    const service = systemService('launchd', target('/Users/ada/a&b'));

    expect(service.file).toBe(
      join(home, 'Library', 'LaunchAgents', 'com.perokit.pero.plist'),
    );
    expect(service.contents).toContain(
      '    <string>run</string>\n    <string>--foreground</string>\n    <string>--workspace</string>\n    <string>/Users/ada/a&amp;b</string>\n',
    );
    expect(service.contents).toContain(
      '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    );
    expect(service.contents).toContain(
      '<key>StandardOutPath</key><string>/Users/ada/a&amp;b/.pero/logs/daemon.out</string>',
    );
  });

  it('finds systemd only when its user instance answers', async () => {
    const answering = recorder(() => ok);
    await expect(detectServiceManager(answering.exec, 'linux')).resolves.toBe(
      'systemd',
    );
    expect(answering.calls).toEqual(['systemctl --user show-environment']);

    const absent = recorder(() => ({
      code: null,
      stdout: '',
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    }));
    await expect(
      detectServiceManager(absent.exec, 'linux'),
    ).resolves.toBeNull();
    await expect(detectServiceManager(absent.exec, 'darwin')).resolves.toBe(
      'launchd',
    );
    await expect(
      detectServiceManager(absent.exec, 'win32'),
    ).resolves.toBeNull();
  });

  it('installs, enables, and starts the systemd unit, then removes it', async () => {
    const service = systemService('systemd', target());
    const { exec, calls } = recorder(() => ok);

    await expect(installService(service, exec)).resolves.toEqual([]);
    expect(readFileSync(service.file, 'utf8')).toBe(service.contents);
    expect(statSync(service.file).mode & 0o777).toBe(0o644);
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable pero.service',
      'systemctl --user restart pero.service',
      'loginctl enable-linger',
    ]);

    calls.length = 0;
    await uninstallService(service, exec);
    expect(existsSync(service.file)).toBe(false);
    expect(calls).toEqual([
      'systemctl --user disable --now pero.service',
      'systemctl --user daemon-reload',
    ]);
  });

  it('says how to keep it running from boot when lingering is refused', async () => {
    const service = systemService('systemd', target());
    const { exec } = recorder((command) =>
      command === 'loginctl' ? { code: 1, stdout: '' } : ok,
    );

    await expect(installService(service, exec)).resolves.toEqual([
      expect.stringContaining('sudo loginctl enable-linger $USER'),
    ]);
  });

  it('stops with the output of a failing systemctl', async () => {
    const service = systemService('systemd', target());
    const { exec } = recorder((_, args) =>
      args.includes('restart')
        ? { code: 1, stdout: '', stderr: 'Job failed.\n' }
        : ok,
    );

    await expect(installService(service, exec)).rejects.toThrow(
      'systemctl --user restart pero.service failed: Job failed.',
    );
  });

  it('loads the launchd agent again on install, and unloads it on removal', async () => {
    const service = systemService('launchd', target());
    const { exec, calls } = recorder((_, args) =>
      args[0] === 'bootout' ? { code: 3, stdout: '' } : ok,
    );

    await installService(service, exec, 501);
    expect(calls).toEqual([
      'launchctl bootout gui/501/com.perokit.pero',
      `launchctl bootstrap gui/501 ${service.file}`,
    ]);
    await uninstallService(service, exec, 501);
    expect(existsSync(service.file)).toBe(false);
  });
});
