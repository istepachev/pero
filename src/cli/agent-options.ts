import type { AgentEdit } from '../config/agent-input.js';
import { resolvePath } from '../config/bootstrap-config.js';
import type {
  Provider,
  ProviderOptionsPatch,
} from '../config/provider-options.js';
import type { PermissionMode } from '../config/tool-policy.js';
import { CliError } from './errors.js';
import type { PathContext } from './settings-keys.js';

/**
 * Options of `pero agents create` and `edit` as commander parses them:
 * `false` is the `--no-…` form, which returns a setting to its default.
 */
export interface AgentOptions {
  title?: string | false;
  provider?: string;
  model?: string | false;
  effort?: string | false;
  workingDirectory?: string;
  followDefault?: boolean;
  instructions?: string | false;
  sharedInstructions?: boolean;
  permissions?: string;
  skipGitRepoCheck?: boolean;
}

export interface AgentOptionsContext extends PathContext {
  /** All of standard input, for `--instructions -`. */
  stdin(): Promise<string>;
}

/**
 * The Agent fields `options` set; omitted options are left out. Folders
 * resolve from the current folder and `~`; the daemon validates the rest.
 */
export async function agentChange(
  options: AgentOptions,
  context: AgentOptionsContext,
): Promise<AgentEdit> {
  if (options.workingDirectory !== undefined && options.followDefault) {
    throw new CliError(
      'Give either --working-directory or --follow-default, not both',
    );
  }
  const change: AgentEdit = {};
  if (options.title !== undefined) {
    change.title = options.title === false ? null : options.title;
  }
  if (options.provider !== undefined) {
    change.provider = options.provider as Provider;
  }
  const providerOptions: ProviderOptionsPatch = {};
  if (options.model !== undefined) {
    providerOptions.model = options.model === false ? null : options.model;
  }
  if (options.effort !== undefined) {
    providerOptions.effort =
      options.effort === false
        ? null
        : (options.effort as ProviderOptionsPatch['effort']);
  }
  if (Object.keys(providerOptions).length > 0) {
    change.providerOptions = providerOptions;
  }
  if (options.workingDirectory !== undefined) {
    change.workingDirectory = resolvePath(
      options.workingDirectory,
      context.cwd,
      context.home,
    );
  }
  if (options.followDefault) change.workingDirectory = null;
  if (options.instructions !== undefined) {
    change.instructions = await instructions(options.instructions, context);
  }
  if (options.sharedInstructions !== undefined) {
    change.useSharedInstructions = options.sharedInstructions;
  }
  if (options.permissions !== undefined) {
    change.permissions = options.permissions as PermissionMode;
  }
  if (options.skipGitRepoCheck !== undefined) {
    change.codexSkipGitRepoCheck = options.skipGitRepoCheck;
  }
  return change;
}

async function instructions(
  value: string | false,
  context: AgentOptionsContext,
): Promise<string | null> {
  if (value === false) return null;
  const text = value === '-' ? await context.stdin() : value;
  if (text.trim() === '') {
    throw new CliError(
      'No instructions given; use --no-instructions to remove them',
    );
  }
  return text;
}

/** Fields the daemon names in its messages, and the options that set them. */
const OPTION_NAMES: readonly [RegExp, string][] = [
  [/\b(change\.)?providerOptions\.model\b/g, '--model'],
  [/\b(change\.)?providerOptions\.effort\b/g, '--effort'],
  [/\b(change\.)?providerOptions\b/g, '--model/--effort'],
  [/(^|; )(change\.)?provider:/g, '$1--provider:'],
  [/(^|; )(change\.)?workingDirectory:/g, '$1--working-directory:'],
  [/(^|; )(change\.)?permissions:/g, '$1--permissions:'],
  [/(^|; )(change\.)?title:/g, '$1--title:'],
  [/(^|; )(change\.)?instructions:/g, '$1--instructions:'],
  [/(^|; )name:/g, '$1<name>:'],
];

/** A daemon message about Agent fields, naming the options instead. */
export function renameAgentFields(message: string): string {
  return OPTION_NAMES.reduce(
    (text, [field, option]) => text.replace(field, option),
    message,
  );
}
