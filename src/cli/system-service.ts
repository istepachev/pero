import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceLayout } from '../config/workspace-layout.js';
import type { Exec } from '../providers/provider-auth.js';
import { CliError } from './errors.js';

/** The service managers `pero service install` writes for. */
export type ServiceManager = 'systemd' | 'launchd';

/** The CLI's entry point, which the service runs. */
export const CLI_MAIN = fileURLToPath(
  new URL('../../bin/pero.js', import.meta.url),
);

const SYSTEMD_UNIT = 'pero.service';
const LAUNCHD_LABEL = 'com.perokit.pero';

/** How long one `systemctl` or `launchctl` call may take. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Pero as a service of the account running it. */
export interface SystemService {
  manager: ServiceManager;
  /** The systemd unit or launchd property list. */
  file: string;
  /** How the owner refers to it, such as `systemd user service pero.service`. */
  name: string;
  contents: string;
}

/** Where and how the service runs Pero. */
export interface ServiceTarget {
  layout: WorkspaceLayout;
  home: string;
  /** The Node.js executable. */
  node: string;
  /** `bin/pero.js`. */
  cli: string;
  /** `PATH` for the service, so it finds the provider CLIs. */
  path: string;
  /** `XDG_CONFIG_HOME`, when set. */
  configHome?: string;
}

/**
 * The service manager of this account: launchd on macOS, and systemd on
 * Linux when its user instance answers. Null when there is none to use.
 */
export async function detectServiceManager(
  exec: Exec,
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceManager | null> {
  if (platform === 'darwin') return 'launchd';
  if (platform !== 'linux') return null;
  const outcome = await exec('systemctl', ['--user', 'show-environment'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return outcome.code === 0 ? 'systemd' : null;
}

/**
 * The service that runs `pero run --foreground` for the workspace, starts
 * with the account, and restarts it after a crash. `pero stop` exits
 * cleanly, so the service leaves it stopped.
 */
export function systemService(
  manager: ServiceManager,
  target: ServiceTarget,
): SystemService {
  const args = [
    target.node,
    target.cli,
    'run',
    '--foreground',
    '--workspace',
    target.layout.workspace,
  ];
  if (manager === 'systemd') {
    const configHome = target.configHome || join(target.home, '.config');
    return {
      manager,
      file: join(configHome, 'systemd', 'user', SYSTEMD_UNIT),
      name: `systemd user service ${SYSTEMD_UNIT}`,
      contents: [
        '# Written by pero service install; pero service uninstall removes it.',
        '[Unit]',
        `Description=Pero (${systemdEscape(target.layout.workspace)})`,
        'After=network-online.target',
        '',
        '[Service]',
        `ExecStart=${args.map((arg) => `"${systemdEscape(arg).replaceAll('$', '$$$$')}"`).join(' ')}`,
        `Environment="PATH=${systemdEscape(target.path)}"`,
        'Restart=on-failure',
        'RestartSec=5',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    };
  }
  const output = target.layout.daemonOutputFile;
  return {
    manager,
    file: join(
      target.home,
      'Library',
      'LaunchAgents',
      `${LAUNCHD_LABEL}.plist`,
    ),
    name: `launchd agent ${LAUNCHD_LABEL}`,
    contents: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<!-- Written by pero service install; pero service uninstall removes it. -->',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...args.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      `  <dict><key>PATH</key><string>${xmlEscape(target.path)}</string></dict>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
      `  <key>StandardOutPath</key><string>${xmlEscape(output)}</string>`,
      `  <key>StandardErrorPath</key><string>${xmlEscape(output)}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  };
}

export function isServiceInstalled(service: SystemService): boolean {
  return existsSync(service.file);
}

/**
 * Writes `service`, enables it, and starts it now. Returns what the owner
 * should know, such as systemd stopping it at logout.
 */
export async function installService(
  service: SystemService,
  exec: Exec,
  uid: number = process.getuid?.() ?? 0,
): Promise<string[]> {
  mkdirSync(dirname(service.file), { recursive: true });
  writeFileSync(service.file, service.contents, { mode: 0o644 });
  if (service.manager === 'launchd') {
    // Loaded already, as when installing again: unload it first.
    await run(exec, 'launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], {
      check: false,
    });
    await run(exec, 'launchctl', ['bootstrap', `gui/${uid}`, service.file]);
    return [];
  }
  await run(exec, 'systemctl', ['--user', 'daemon-reload']);
  await run(exec, 'systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
  await run(exec, 'systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
  // Without lingering, systemd stops user services at logout and starts
  // them only at login.
  const linger = await run(exec, 'loginctl', ['enable-linger'], {
    check: false,
  });
  return linger
    ? []
    : [
        'Pero starts when you log in and stops when you log out. To keep it running from boot, run: sudo loginctl enable-linger $USER',
      ];
}

/** Stops `service`, disables it, and removes its file. */
export async function uninstallService(
  service: SystemService,
  exec: Exec,
  uid: number = process.getuid?.() ?? 0,
): Promise<void> {
  if (service.manager === 'launchd') {
    await run(exec, 'launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], {
      check: false,
    });
    rmSync(service.file, { force: true });
    return;
  }
  await run(exec, 'systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], {
    check: false,
  });
  rmSync(service.file, { force: true });
  await run(exec, 'systemctl', ['--user', 'daemon-reload']);
}

/**
 * The pid of the process `service` runs now; null when it runs none, or
 * when the service manager does not say.
 */
export async function servicePid(
  service: SystemService,
  exec: Exec,
): Promise<number | null> {
  const outcome =
    service.manager === 'launchd'
      ? await exec('launchctl', ['list', LAUNCHD_LABEL], {
          timeoutMs: COMMAND_TIMEOUT_MS,
        })
      : await exec(
          'systemctl',
          ['--user', 'show', '--property', 'MainPID', '--value', SYSTEMD_UNIT],
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
  if (outcome.code !== 0) return null;
  const pid = Number(
    service.manager === 'launchd'
      ? /"PID" = (\d+);/.exec(outcome.stdout)?.[1]
      : outcome.stdout.trim(),
  );
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Starts the installed `service` again, as after `pero stop`: Pero exits
 * cleanly then, so the service manager left it stopped.
 */
export async function startService(
  service: SystemService,
  exec: Exec,
  uid: number = process.getuid?.() ?? 0,
): Promise<void> {
  if (service.manager === 'launchd') {
    await run(exec, 'launchctl', ['kickstart', `gui/${uid}/${LAUNCHD_LABEL}`]);
    return;
  }
  await run(exec, 'systemctl', ['--user', 'start', SYSTEMD_UNIT]);
}

/** Where to look when the service does not start. */
export function serviceLogsHint(service: SystemService): string {
  return service.manager === 'systemd'
    ? `see systemctl --user status ${SYSTEMD_UNIT} and journalctl --user -u ${SYSTEMD_UNIT}`
    : `see launchctl print gui/$(id -u)/${LAUNCHD_LABEL}`;
}

/**
 * Runs a service manager command; false when it fails and `check` is
 * false, and a `CliError` with its output when it fails otherwise.
 */
async function run(
  exec: Exec,
  command: string,
  args: string[],
  { check = true }: { check?: boolean } = {},
): Promise<boolean> {
  const outcome = await exec(command, args, { timeoutMs: COMMAND_TIMEOUT_MS });
  if (outcome.code === 0) return true;
  if (!check) return false;
  const output = (outcome.stderr ?? '').trim() || outcome.stdout.trim();
  const reason =
    outcome.error?.message ?? `exited with code ${String(outcome.code)}`;
  throw new CliError(
    `${command} ${args.join(' ')} failed: ${output || reason}`,
  );
}

/** `value` for a double-quoted systemd setting. */
function systemdEscape(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%');
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
