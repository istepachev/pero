import { Command, SubCommand } from 'nest-commander';
import {
  ensureWorkspaceLayout,
  type WorkspaceLayout,
} from '../../config/workspace-layout.js';
import { findRunningDaemon } from '../../control/daemon-metadata.js';
import { execCommand } from '../../providers/provider-auth.js';
import { CliError } from '../errors.js';
import { PeroCommand } from '../pero-command.js';
import {
  formatRunning,
  localService,
  startAsService,
} from '../run-as-service.js';
import {
  isServiceInstalled,
  type SystemService,
  uninstallService,
} from '../system-service.js';

@SubCommand({
  name: 'install',
  description:
    'Run Pero as a service of this account: started with it, restarted after a crash',
})
export class ServiceInstallCommand extends PeroCommand {
  async run(): Promise<void> {
    // The service's output goes to logs/, which must exist before it starts.
    const layout = ensureWorkspaceLayout(this.config().workspace);
    const service = await requireService(layout);
    const status = await startAsService(service, layout, execCommand, (text) =>
      console.log(text),
    );
    console.log(formatRunning(status, service, true));
  }
}

@SubCommand({
  name: 'uninstall',
  description: 'Stop the service and remove it; pero run starts Pero again',
})
export class ServiceUninstallCommand extends PeroCommand {
  async run(): Promise<void> {
    const layout = this.layout();
    const service = await requireService(layout);
    if (!isServiceInstalled(service)) {
      console.log(`The ${service.name} is not installed (${service.file})`);
      return;
    }
    await uninstallService(service, execCommand);
    const left = await findRunningDaemon(layout.metadataFile);
    console.log(
      `Removed the ${service.name}. ` +
        (left === null
          ? "Pero isn't running; pero run starts it in the background."
          : `Pero still runs (pid ${left.metadata.pid}); pero stop stops it.`),
    );
  }
}

@Command({
  name: 'service',
  description:
    'Show, install, or remove Pero as a service that starts with the machine',
  subCommands: [ServiceInstallCommand, ServiceUninstallCommand],
})
export class ServiceCommand extends PeroCommand {
  async run(): Promise<void> {
    const service = await requireService(this.layout());
    console.log(
      isServiceInstalled(service)
        ? `Pero is installed as the ${service.name} (${service.file})`
        : `Pero is not installed as a service; pero service install installs the ${service.name}`,
    );
  }
}

async function requireService(layout: WorkspaceLayout): Promise<SystemService> {
  const service = await localService(layout, execCommand);
  if (service === null) {
    throw new CliError(
      'No service manager found: pero service needs systemd (a user instance, systemctl --user) on Linux, or launchd on macOS. Run pero run --foreground under your own supervisor instead.',
    );
  }
  return service;
}
