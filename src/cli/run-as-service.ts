import { homedir } from 'node:os';
import { PACKAGE_VERSION } from '../common/package-version.js';
import { TELEGRAM_TOKEN_ENV } from '../config/settings-input.js';
import type { WorkspaceLayout } from '../config/workspace-layout.js';
import { createControlClient } from '../control/client.js';
import { findRunningDaemon } from '../control/daemon-metadata.js';
import type { StatusResult } from '../control/protocol.js';
import type { Exec } from '../providers/provider-auth.js';
import { CliError } from './errors.js';
import { formatStatus } from './format-status.js';
import { waitForDaemon } from './start-daemon.js';
import { stopDaemon } from './stop-daemon.js';
import {
  CLI_MAIN,
  detectServiceManager,
  installService,
  serviceLogsHint,
  type SystemService,
  systemService,
} from './system-service.js';

/** The service this account would run Pero as; null without a manager. */
export async function localService(
  layout: WorkspaceLayout,
  exec: Exec,
): Promise<SystemService | null> {
  const manager = await detectServiceManager(exec);
  if (manager === null) return null;
  return systemService(manager, {
    layout,
    home: homedir(),
    node: process.execPath,
    cli: CLI_MAIN,
    path: process.env.PATH ?? '',
    ...(process.env.XDG_CONFIG_HOME
      ? { configHome: process.env.XDG_CONFIG_HOME }
      : {}),
  });
}

/**
 * Hands Pero over to `service`: stops the daemon running outside it, if
 * any, installs and starts the service, and waits for its daemon to be
 * ready.
 */
export async function startAsService(
  service: SystemService,
  layout: WorkspaceLayout,
  exec: Exec,
  print: (text: string) => void,
): Promise<StatusResult> {
  const running = await findRunningDaemon(layout.metadataFile);
  if (running !== null) {
    print(
      `Stopping Pero (pid ${running.metadata.pid}) to start it as a service…`,
    );
    await stopDaemon(
      createControlClient(running.metadata.socket),
      running.metadata.pid,
      layout,
    );
  }
  const notes = await installService(service, exec);
  print(`Installed the ${service.name} (${service.file})`);
  const status = await waitForDaemon(layout);
  if (status === null) {
    throw new CliError(
      `The ${service.name} did not become ready; ${serviceLogsHint(service)}. ` +
        `Logs: ${layout.logFile}, ${layout.daemonOutputFile}`,
    );
  }
  for (const note of notes) print(note);
  if (process.env[TELEGRAM_TOKEN_ENV]) {
    print(
      `The service does not get ${TELEGRAM_TOKEN_ENV} from this shell; store the token with pero telegram token.`,
    );
  }
  return status;
}

/**
 * `pero status` for `status`, then how Pero keeps running: as `service`,
 * when installed, or in the background until a reboot; `canInstall` says
 * whether `pero service install` would work here.
 */
export function formatRunning(
  status: StatusResult,
  service: SystemService | null,
  canInstall: boolean,
): string {
  const how =
    service !== null
      ? `Pero is installed as the ${service.name}: it starts with the machine and restarts after a crash. pero service uninstall removes it.`
      : 'Pero runs in the background and keeps running after you close this terminal, until pero stop or a reboot.' +
        (canInstall ? ' pero service install starts it with the machine.' : '');
  return `${formatStatus(status, PACKAGE_VERSION)}\n\n${how}`;
}
