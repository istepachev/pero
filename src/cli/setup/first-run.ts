import {
  type BootstrapConfig,
  NoWorkspaceError,
  resolveBootstrapConfig,
} from '../../config/bootstrap-config.js';
import { initWorkspace } from '../../config/workspace-skeleton.js';
import { formatInit } from '../format-init.js';
import { isPromptExit, type Prompts } from '../prompts.js';

export interface FirstRunContext {
  /** The configuration commands resolve; throws when no workspace is found. */
  config: () => BootstrapConfig;
  /** Whether questions can be asked, on a terminal. */
  interactive: boolean;
  prompts: () => Promise<Prompts>;
  print: (text: string) => void;
  home?: string;
}

/**
 * The configuration `pero run` starts with. When no workspace is found, a
 * terminal is offered one where it suits (the current folder, or
 * `~/workspace` from home), made as `pero init` makes it; declining, or
 * having no terminal, stops with the `pero init` to run.
 */
export async function configOrNewWorkspace(
  context: FirstRunContext,
): Promise<BootstrapConfig> {
  try {
    return context.config();
  } catch (error) {
    if (!(error instanceof NoWorkspaceError) || !context.interactive) {
      throw error;
    }
    const { suggested } = error;
    let create: boolean;
    try {
      create = await (
        await context.prompts()
      ).confirm({
        message: `No Pero workspace found. Create one in ${suggested}?`,
        initial: true,
      });
    } catch (prompt) {
      if (isPromptExit(prompt)) throw error;
      throw prompt;
    }
    if (!create) throw error;
    context.print(formatInit(initWorkspace(suggested, context.home), false));
    return resolveBootstrapConfig({
      workspace: suggested,
      ...(context.home === undefined ? {} : { homeDir: context.home }),
    });
  }
}
