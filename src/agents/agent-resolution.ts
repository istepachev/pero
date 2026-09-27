import type { Agent } from '../persistence/entities/agent.entity.js';
import type { Settings } from '../persistence/entities/settings.entity.js';

/** The folder an Agent works in: its own, otherwise the shared default. */
export function effectiveWorkingDirectory(
  agent: Pick<Agent, 'workingDirectory'>,
  settings: Pick<Settings, 'defaultWorkingDirectory'>,
): string {
  const folder = agent.workingDirectory ?? settings.defaultWorkingDirectory;
  // Creation and edits refuse to follow an unset default, so this means a
  // row was changed outside the services.
  if (folder === null) {
    throw new Error(
      'Agent follows the default working directory, which is unset',
    );
  }
  return folder;
}

/**
 * The instructions sent to the runtime: the shared instructions, unless the
 * Agent opts out, then the Agent's own, separated by a blank line. Empty
 * parts are left out.
 */
export function composeInstructions(
  agent: Pick<Agent, 'instructions' | 'useSharedInstructions'>,
  settings: Pick<Settings, 'sharedInstructions'>,
): string {
  const parts = [
    agent.useSharedInstructions ? settings.sharedInstructions : null,
    agent.instructions,
  ];
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
}
