import { setTimeout as sleep } from 'node:timers/promises';
import { Command, Option } from 'nest-commander';
import { NoWorkspaceError } from '../../config/bootstrap-config.js';
import type { WorkspaceLayout } from '../../config/workspace-layout.js';
import { PACKAGE_ROOT, PACKAGE_VERSION } from '../../common/package-version.js';
import { createControlClient } from '../../control/client.js';
import { findRunningDaemon } from '../../control/daemon-metadata.js';
import type { StatusResult } from '../../control/protocol.js';
import { execCommand } from '../../providers/provider-auth.js';
import { CliError } from '../errors.js';
import { formatStatus } from '../format-status.js';
import { PeroCommand } from '../pero-command.js';
import { localService } from '../run-as-service.js';
import { startDetachedDaemon, waitForDaemon } from '../start-daemon.js';
import { stopDaemon } from '../stop-daemon.js';
import {
  isServiceInstalled,
  serviceLogsHint,
  servicePid,
  startService,
} from '../system-service.js';
import {
  compareVersions,
  installVersion,
  latestVersion,
  localNpm,
  requireGlobalInstall,
  versionOnDisk,
} from '../upgrade.js';

/**
 * How long a restarted Pero gets to check sign-ins and connect to Telegram
 * before its status is shown.
 */
const SETTLE_MS = 3000;

interface UpgradeOptions {
  check?: boolean;
}

// Everything this command runs after npm replaces the package is imported
// statically: a module loaded later would come from the new version.
@Command({
  name: 'upgrade',
  description:
    'Install the latest version of Pero and restart it when it is running',
})
export class UpgradeCommand extends PeroCommand {
  async run(_params: string[], options: UpgradeOptions): Promise<void> {
    const npm = localNpm();
    const latest = await latestVersion(npm, execCommand);
    const order = compareVersions(PACKAGE_VERSION, latest);

    if (options.check) {
      console.log(
        order < 0
          ? `Pero ${PACKAGE_VERSION} is installed; ${latest} is available. pero upgrade installs it.`
          : upToDate(latest),
      );
      return;
    }

    const layout = this.workspaceLayout();
    let version = PACKAGE_VERSION;
    if (order < 0) {
      await requireGlobalInstall(npm, execCommand, PACKAGE_ROOT);
      console.log(`Upgrading Pero ${PACKAGE_VERSION} to ${latest}…`);
      await installVersion(npm, execCommand, latest);
      version = versionOnDisk(PACKAGE_ROOT);
      if (version !== latest) {
        throw new CliError(
          `npm installed ${latest}, but this pero is still ${version}; run npm install -g @perokit/pero@${latest} to see why.`,
        );
      }
      console.log(`Installed Pero ${version}`);
    } else {
      console.log(upToDate(latest));
    }

    if (layout !== null) await this.restart(layout, version);
  }

  /** The workspace's paths; null when there is no workspace to restart. */
  private workspaceLayout(): WorkspaceLayout | null {
    try {
      return this.layout();
    } catch (error) {
      if (error instanceof NoWorkspaceError) return null;
      throw error;
    }
  }

  /**
   * Restarts the workspace's Pero when it runs another version than
   * `version`: through the service when the service runs it, and in the
   * background otherwise. A stopped Pero stays stopped.
   */
  private async restart(
    layout: WorkspaceLayout,
    version: string,
  ): Promise<void> {
    const running = await findRunningDaemon(layout.metadataFile);
    if (running === null) {
      console.log(
        `Pero isn't running (workspace ${layout.workspace}); pero run starts ${version}.`,
      );
      return;
    }
    const { pid } = running.metadata;
    if (running.status.version === version) return;

    const service = await localService(layout, execCommand);
    const supervised =
      service !== null &&
      isServiceInstalled(service) &&
      (await servicePid(service, execCommand)) === pid;

    console.log(
      `Restarting Pero (pid ${pid}, version ${running.status.version})…`,
    );
    await stopDaemon(createControlClient(running.metadata.socket), pid, layout);
    let status: StatusResult | null;
    if (supervised) {
      await startService(service, execCommand);
      status = await waitForDaemon(layout);
      if (status === null) {
        throw new CliError(
          `The ${service.name} did not become ready; ${serviceLogsHint(service)}. ` +
            `Logs: ${layout.logFile}, ${layout.daemonOutputFile}`,
        );
      }
    } else {
      ({ status } = await startDetachedDaemon(layout));
    }
    await sleep(SETTLE_MS);
    status = (await findRunningDaemon(layout.metadataFile))?.status ?? status;
    console.log(`\n${formatStatus(status, version)}`);
  }

  @Option({
    flags: '--check',
    description: 'only say whether a newer version is available',
  })
  parseCheck(): boolean {
    return true;
  }
}

function upToDate(latest: string): string {
  return compareVersions(PACKAGE_VERSION, latest) === 0
    ? `Pero ${PACKAGE_VERSION} is the latest version`
    : `Pero ${PACKAGE_VERSION} is newer than the latest release, ${latest}`;
}
