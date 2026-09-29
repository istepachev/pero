import { homedir } from 'node:os';
import { Command, CommandRunner } from 'nest-commander';
import { resolvePath } from '../../config/bootstrap-config.js';
import { initWorkspace } from '../../config/workspace-skeleton.js';
import { formatInit } from '../format-init.js';
import type { GlobalOptions } from '../global-options.js';

@Command({
  name: 'init',
  arguments: '[dir]',
  description:
    'Make a folder a Pero workspace, writing what is missing of its skeleton',
  argsDescription: {
    dir: 'the workspace folder (default: --workspace, then the current folder)',
  },
})
export class InitCommand extends CommandRunner {
  async run([dir]: string[]): Promise<void> {
    const { workspace } = this.command.optsWithGlobals<GlobalOptions>();
    const home = homedir();
    const target = resolvePath(
      dir ?? workspace ?? process.cwd(),
      process.cwd(),
      home,
    );
    console.log(formatInit(initWorkspace(target, home)));
    return Promise.resolve();
  }
}
