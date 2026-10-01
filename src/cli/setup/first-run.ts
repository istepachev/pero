import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type BootstrapConfig,
  NoWorkspaceError,
  resolveBootstrapConfig,
} from '../../config/bootstrap-config.js';
import {
  hostConfigPath,
  readHostConfig,
  resolveSettingsFolder,
} from '../../config/host-config.js';
import { type Provider, PROVIDERS } from '../../config/provider-options.js';
import { workspaceLayout } from '../../config/workspace-layout.js';
import { initWorkspace } from '../../config/workspace-skeleton.js';
import {
  checkProviderAuth,
  cliLabel,
  type Exec,
  installHint,
  type ProviderAuthResult,
  signInHint,
} from '../../providers/provider-auth.js';
import { PERO_NOTE } from '../../settings-files/note-files.js';
import { parseNote } from '../../settings-files/note.js';
import { setNoteProperty } from '../../settings-files/note-writer.js';
import { CliError } from '../errors.js';
import { formatInit } from '../format-init.js';
import { isPromptExit, type Prompts } from '../prompts.js';

export interface FirstRunContext {
  /** The configuration commands resolve; throws when no workspace is found. */
  config: () => BootstrapConfig;
  /** Whether questions can be asked, on a terminal. */
  interactive: boolean;
  prompts: () => Promise<Prompts>;
  print: (text: string) => void;
  /** Starts a new block of output: the provider, then the workspace. */
  block?: () => void;
  home?: string;
  /**
   * False to start without settling a provider, as with the echo runtime,
   * which needs none.
   */
  checkProviders?: boolean;
  /** How provider CLIs are run; for tests. */
  exec?: Exec;
}

export interface FirstRun {
  config: BootstrapConfig;
  /**
   * Whether this is the workspace's first start on a terminal: it has no
   * database yet, and the default provider was just settled.
   */
  firstRun: boolean;
}

/**
 * The configuration `pero run` starts with. When no workspace is found, a
 * terminal is offered one where it suits (the current folder, or
 * `~/workspace` from home), made as `pero init` makes it; declining, or
 * having no terminal, stops with the `pero init` to run.
 *
 * On a terminal, a workspace's first start (no database yet) first settles
 * the provider its Agents use: the one `Pero.md` sets, or else the owner's
 * pick among the provider CLIs installed, written to `Pero.md`. It refuses
 * to go on, before anything is made or started, while that provider's CLI
 * is missing or signed out.
 */
export async function configOrNewWorkspace(
  context: FirstRunContext,
): Promise<FirstRun> {
  let config: BootstrapConfig | null = null;
  let suggested: string;
  try {
    config = context.config();
    suggested = config.workspace;
  } catch (error) {
    if (!(error instanceof NoWorkspaceError) || !context.interactive) {
      throw error;
    }
    suggested = error.suggested;
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
  }

  const workspace = config?.workspace ?? suggested;
  if (!context.interactive || existsSync(workspaceLayout(workspace).database)) {
    return { config: config!, firstRun: false };
  }

  const note = peroNotePath(workspace, context.home);
  const block = context.block ?? (() => undefined);
  let provider: Provider | null = null;
  try {
    if (context.checkProviders !== false) {
      block();
      provider = await settleProvider(context, providerIn(note));
    }
  } catch (error) {
    if (!isPromptExit(error)) throw error;
    throw new CliError('Setup interrupted; Pero was not started.', 130);
  }

  block();
  if (config === null) {
    context.print(formatInit(initWorkspace(suggested, context.home), false));
    config = resolveBootstrapConfig({
      workspace: suggested,
      ...(context.home === undefined ? {} : { homeDir: context.home }),
    });
  }
  if (provider !== null) writeProvider(note, provider, context.print);
  return { config, firstRun: true };
}

/** `Pero.md` of `workspace`, where its `config.yaml` puts the settings. */
function peroNotePath(workspace: string, home?: string): string {
  const stateDir = workspaceLayout(workspace).stateDir;
  const config = readHostConfig(hostConfigPath(stateDir)) ?? {
    data: null,
    settings: null,
  };
  return join(resolveSettingsFolder(config, workspace, home), PERO_NOTE);
}

/** The provider the note at `path` sets; null when it sets none. */
function providerIn(path: string): Provider | null {
  const text = readText(path);
  if (text === null) return null;
  const parsed = parseNote(path, text);
  if (!parsed.ok) return null;
  const value = parsed.note.properties.provider;
  return PROVIDERS.find((provider) => provider === value) ?? null;
}

/**
 * The provider to start with: `fixed`, or the one installed CLI, or the
 * owner's pick when both are. Waits for it to be signed in; throws a
 * `CliError` saying what to do when no CLI is installed or the owner
 * quits while it is signed out.
 */
async function settleProvider(
  context: FirstRunContext,
  fixed: Provider | null,
): Promise<Provider> {
  const { print } = context;
  const check = (provider: Provider) =>
    checkProviderAuth(provider, context.exec ? { exec: context.exec } : {});
  const found = new Map<Provider, ProviderAuthResult>(
    await Promise.all(
      PROVIDERS.map(
        async (provider) => [provider, await check(provider)] as const,
      ),
    ),
  );
  const installed = PROVIDERS.filter((p) => found.get(p)!.installed);

  let provider: Provider;
  if (fixed !== null) {
    if (!installed.includes(fixed)) {
      throw new CliError(
        `Pero.md sets provider: ${fixed}, but the ${cliLabel(fixed)} was not found. ` +
          `Install it with ${installHint(fixed)}, sign in with ${signInHint(fixed)}, then run pero run again.`,
      );
    }
    provider = fixed;
    print(`Provider: ${provider}, as Pero.md sets it`);
  } else if (installed.length === 0) {
    throw new CliError(
      [
        'Pero runs its Agents with Claude Code or Codex, and neither CLI was found. Install one and sign in, then run pero run again:',
        ...PROVIDERS.map(
          (p) => `  ${cliLabel(p)}: ${installHint(p)}, then ${signInHint(p)}`,
        ),
      ].join('\n'),
    );
  } else if (installed.length === 1) {
    provider = installed[0]!;
    const missing = PROVIDERS.filter((p) => p !== provider)
      .map(cliLabel)
      .join(', ');
    print(`Provider: ${provider} (${missing} not found)`);
  } else {
    const prompts = await context.prompts();
    provider = await prompts.select({
      message: 'Which provider should your Agents use?',
      choices: PROVIDERS.map((p) => ({
        value: p,
        name: `${p} — ${cliLabel(p)}, ${found.get(p)!.state === 'ok' ? 'signed in' : 'not signed in'}`,
      })),
      initial:
        PROVIDERS.find((p) => found.get(p)!.state === 'ok') ?? PROVIDERS[0],
    });
  }

  let result = found.get(provider)!;
  while (result.state !== 'ok') {
    print(`${provider}: ${result.detail}`);
    const answer = await (
      await context.prompts()
    ).input({
      message:
        'Sign in in another terminal, then press Enter to check again (q to quit)',
    });
    if (answer.trim().toLowerCase() === 'q') {
      throw new CliError(
        `Pero needs a signed-in provider. Run ${signInHint(provider)}, then pero run again.`,
      );
    }
    result = await check(provider);
    if (!result.installed) {
      throw new CliError(
        `The ${cliLabel(provider)} was not found any more. Install it with ${installHint(provider)}, then run pero run again.`,
      );
    }
  }
  print(`${provider}: ${result.detail}`);
  return provider;
}

/** Sets `provider` in the note at `path` unless it sets one already. */
function writeProvider(
  path: string,
  provider: Provider,
  print: (text: string) => void,
): void {
  const text = readText(path) ?? '';
  const updated = setNoteProperty(text, 'provider', provider);
  if (updated === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, updated);
  print(`Agents use ${provider}; change it with provider: in ${path}`);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
