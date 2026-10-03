import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type BootstrapConfig,
  ConfigError,
  NoWorkspaceError,
  resolveBootstrapConfig,
} from '../../config/bootstrap-config.js';
import {
  DEFAULT_DATA_FOLDER,
  type HostConfig,
  hostConfigPath,
  readHostConfig,
  resolveDataFolder,
  resolveSystemFolder,
} from '../../config/host-config.js';
import { type Provider, PROVIDERS } from '../../config/provider-options.js';
import {
  PERMISSION_MODES,
  type PermissionMode,
} from '../../config/tool-policy.js';
import { workspaceLayout } from '../../config/workspace-layout.js';
import { initWorkspace, peroNote } from '../../config/workspace-skeleton.js';
import {
  checkProviderAuth,
  cliLabel,
  type Exec,
  installHint,
  type ProviderAuthResult,
  signInHint,
} from '../../providers/provider-auth.js';
import { PERO_NOTE } from '../../system-files/note-files.js';
import { parseNote } from '../../system-files/note.js';
import { replaceNoteProperty } from '../../system-files/note-writer.js';
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
  /** Whether Pero runs as root, where Claude Code refuses `bypass`; for tests. */
  root?: boolean;
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
 * `~/workspace` from home), made as `pero init` makes it, with the data
 * folder the owner picks among the folders already there or names anew;
 * declining, or having no terminal, stops with the `pero init` to run.
 *
 * On a terminal, a workspace's first start (no database yet) first settles
 * the provider Pero uses: the one `Pero.md` sets, or else the owner's
 * pick among the provider CLIs installed, written to `Pero.md`. It refuses
 * to go on, before anything is made or started, while that provider's CLI
 * is missing or signed out. It then settles the default permission mode
 * the same way: the one `Pero.md` sets, or else the owner's pick of `ask`
 * or `bypass`. A later start whose `Pero.md` is missing, as after the
 * system folder was deleted, settles both the same way and writes a whole
 * `Pero.md` with them, so it doesn't fall back to claude and ask unasked.
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
  if (!context.interactive) return { config: config!, firstRun: false };
  if (existsSync(workspaceLayout(workspace).database)) {
    const missing = missingPeroNote(workspace, context.home);
    if (missing !== null && context.checkProviders !== false) {
      context.block?.();
      let settings: Settings;
      try {
        const provider = await settleProvider(context, null);
        context.block?.();
        const permissions = await settlePermissions(context, provider, null);
        settings = { provider, permissions };
      } catch (error) {
        if (!isPromptExit(error)) throw error;
        throw new CliError('Setup interrupted; Pero was not started.', 130);
      }
      context.block?.();
      writeSettings(missing, settings, context.print);
    }
    return { config: config!, firstRun: false };
  }

  const block = context.block ?? (() => undefined);
  let data: string | undefined;
  let note: string;
  let settings: Settings | null = null;
  try {
    if (config === null) data = await pickDataFolder(context, workspace);
    note = peroNotePath(workspace, context.home, data);
    if (context.checkProviders !== false) {
      block();
      const set = settingsIn(note);
      const provider = await settleProvider(context, set.provider);
      block();
      const permissions = await settlePermissions(
        context,
        provider,
        set.permissions,
      );
      settings = { provider, permissions };
    }
  } catch (error) {
    if (!isPromptExit(error)) throw error;
    throw new CliError('Setup interrupted; Pero was not started.', 130);
  }

  block();
  if (config === null) {
    context.print(
      formatInit(initWorkspace(suggested, context.home, data), false),
    );
    config = resolveBootstrapConfig({
      workspace: suggested,
      ...(context.home === undefined ? {} : { homeDir: context.home }),
    });
  }
  if (settings !== null) writeSettings(note, settings, context.print);
  return { config, firstRun: true };
}

/** The `pickDataFolder` choice that asks the name of a new folder. */
const NEW_FOLDER = '/new';

/**
 * The data folder of a new workspace in `workspace`, relative to it: the
 * owner's pick among the folders already there, with `data/` selected, or
 * else offered to be created, or a new folder the owner names. Asks
 * nothing when there is no folder yet.
 */
async function pickDataFolder(
  context: FirstRunContext,
  workspace: string,
): Promise<string> {
  const folders = foldersIn(workspace);
  if (folders.length === 0) return DEFAULT_DATA_FOLDER;
  const choices = folders.map((name) => ({ value: name, name: `${name}/` }));
  if (!folders.includes(DEFAULT_DATA_FOLDER)) {
    choices.unshift({
      value: DEFAULT_DATA_FOLDER,
      name: `Create ${DEFAULT_DATA_FOLDER}/`,
    });
  }
  choices.push({ value: NEW_FOLDER, name: 'Create a new folder…' });
  const prompts = await context.prompts();
  const picked = await prompts.select({
    message: 'Which folder is the vault Pero keeps notes in?',
    choices,
    initial: DEFAULT_DATA_FOLDER,
  });
  if (picked !== NEW_FOLDER) return picked;
  for (;;) {
    const name = (
      await prompts.input({ message: 'Name of the new folder' })
    ).trim();
    const problem = folderNameProblem(workspace, name);
    if (problem === null) return name;
    context.print(problem);
  }
}

/**
 * Why `name` can't be a new data folder in `workspace`, or null when it
 * can: it is one folder's name, not hidden, and not a file there.
 */
function folderNameProblem(workspace: string, name: string): string | null {
  if (name === '') return 'Type a folder name.';
  if (/[/\\]/.test(name)) {
    return `${name} is not a folder name; type one without / or \\.`;
  }
  if (name.startsWith('.')) {
    return `${name} would be a hidden folder; type a name not starting with a dot.`;
  }
  const path = join(workspace, name);
  if (existsSync(path) && !statSync(path).isDirectory()) {
    return `${name} is a file in ${workspace}; type another name.`;
  }
  return null;
}

/**
 * The folders directly in `dir`, by name, leaving out hidden ones; a link
 * to a folder counts, as a linked vault may be. None when `dir` is missing.
 */
function foldersIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `Pero.md` of `workspace`, where its `config.yaml` puts the system folder; in a
 * workspace without one, in data folder `data`.
 */
function peroNotePath(workspace: string, home?: string, data?: string): string {
  const stateDir = workspaceLayout(workspace).stateDir;
  const config = readHostConfig(hostConfigPath(stateDir)) ?? {
    data: data ?? null,
    system: null,
  };
  return join(resolveSystemFolder(config, workspace, home), PERO_NOTE);
}

/**
 * `Pero.md` of `workspace` when it is missing and its data folder is
 * there, or is `data/`, which `pero run` creates; null otherwise, as with
 * a vault not mounted yet or an invalid `config.yaml`.
 */
function missingPeroNote(workspace: string, home?: string): string | null {
  let config: Pick<HostConfig, 'data' | 'system'>;
  try {
    config = readHostConfig(
      hostConfigPath(workspaceLayout(workspace).stateDir),
    ) ?? { data: null, system: null };
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
  const data = resolveDataFolder(config, workspace, home);
  if (data !== join(workspace, DEFAULT_DATA_FOLDER) && !existsSync(data)) {
    return null;
  }
  const note = join(resolveSystemFolder(config, workspace, home), PERO_NOTE);
  return existsSync(note) ? null : note;
}

/** What first-run setup settles in `Pero.md`. */
interface Settings {
  provider: Provider;
  permissions: PermissionMode;
}

/** The settings the note at `path` sets; null for each it sets none of. */
function settingsIn(path: string): {
  [K in keyof Settings]: Settings[K] | null;
} {
  const none = { provider: null, permissions: null };
  const text = readText(path);
  if (text === null) return none;
  const parsed = parseNote(path, text);
  if (!parsed.ok) return none;
  const { provider, permissions } = parsed.note.properties;
  return {
    provider: PROVIDERS.find((p) => p === provider) ?? null,
    permissions: PERMISSION_MODES.find((m) => m === permissions) ?? null,
  };
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
        'Pero runs with Claude Code or Codex, and neither CLI was found. Install one and sign in, then run pero run again:',
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
      message: 'Which provider should Pero use?',
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

/**
 * The permission mode tools run under by default: `fixed`, or else the
 * owner's pick, `ask` selected first.
 */
async function settlePermissions(
  context: FirstRunContext,
  provider: Provider,
  fixed: PermissionMode | null,
): Promise<PermissionMode> {
  if (fixed !== null) {
    context.print(`Permissions: ${fixed}, as Pero.md sets it`);
    return fixed;
  }
  const permissions = await (
    await context.prompts()
  ).select<PermissionMode>({
    message: 'How should Pero approve its tools by default?',
    choices: [
      {
        value: 'ask',
        name:
          provider === 'claude'
            ? 'ask — edits in its folder run freely; anything else asks you in Telegram (recommended)'
            : 'ask — Codex sandbox: writes and runs commands only in its folder, without network (recommended)',
      },
      {
        value: 'bypass',
        name:
          provider === 'claude'
            ? 'bypass — every tool runs without asking, like claude --dangerously-skip-permissions'
            : 'bypass — no sandbox, like codex --dangerously-bypass-approvals-and-sandbox',
      },
    ],
    initial: 'ask',
  });
  const root = context.root ?? process.getuid?.() === 0;
  if (
    permissions === 'bypass' &&
    provider === 'claude' &&
    root &&
    process.env.IS_SANDBOX !== '1'
  ) {
    context.print(
      'Claude Code refuses bypass when it runs as root unless IS_SANDBOX=1 is set; run Pero as an ordinary account.',
    );
  }
  return permissions;
}

/**
 * Sets each of `settings` in the note at `path` unless it sets that one
 * already, filling in the empty ones `pero init` writes; a missing note
 * starts as `pero init` writes it.
 */
function writeSettings(
  path: string,
  settings: Settings,
  print: (text: string) => void,
): void {
  let text =
    readText(path) ??
    peroNote(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const parsed = parseNote(path, text);
  if (!parsed.ok) return;
  const written: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const current = parsed.note.properties[key];
    if (current !== undefined && current !== null) continue;
    const updated = replaceNoteProperty(text, key, value);
    if (updated === null) return;
    text = updated;
    written.push(`${key}: ${value}`);
  }
  if (written.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  print(
    `Pero.md now sets ${written.join(', ')}; change ${written.length === 1 ? 'it' : 'them'} in ${path}`,
  );
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
