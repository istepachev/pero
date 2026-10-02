import { execFile } from 'node:child_process';
import type { Provider } from '../config/provider-options.js';
import type { ComponentState } from '../control/protocol.js';

/** How long a provider CLI may take to report its sign-in. */
export const AUTH_CHECK_TIMEOUT_MS = 15_000;

/** What one sign-in check found, as a component state for `pero status`. */
export interface ProviderAuthResult {
  state: ComponentState;
  detail: string;
  /** False when the provider's CLI is not on this account's `PATH`. */
  installed: boolean;
}

/** How a provider CLI run ended. */
export interface ExecOutcome {
  /** Exit code; null when the process did not exit on its own. */
  code: number | null;
  stdout: string;
  stderr?: string;
  /** Set when the process could not start or was stopped. */
  error?: NodeJS.ErrnoException & { killed?: boolean };
}

export type Exec = (
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<ExecOutcome>;

export interface CheckOptions {
  exec?: Exec;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ProviderCli {
  label: string;
  command: string;
  args: string[];
  install: string;
  signIn: string;
  /** Reads a completed run: signed in with a detail, or signed out. */
  read(outcome: ExecOutcome): { signedIn: boolean; detail?: string };
}

// Output formats of Claude Code 2.x and Codex CLI 0.1xx.
const CLIS: Record<Provider, ProviderCli> = {
  claude: {
    label: 'Claude Code CLI',
    command: 'claude',
    args: ['auth', 'status', '--json'],
    install: 'npm install -g @anthropic-ai/claude-code',
    signIn: 'claude auth login',
    read({ stdout }) {
      const status = JSON.parse(stdout) as {
        loggedIn?: unknown;
        authMethod?: unknown;
        subscriptionType?: unknown;
      };
      if (typeof status.loggedIn !== 'boolean') {
        throw new Error('no loggedIn field');
      }
      const about = [status.authMethod, status.subscriptionType].filter(
        (part): part is string => typeof part === 'string' && part !== '',
      );
      return {
        signedIn: status.loggedIn,
        detail:
          about.length > 0 ? `Signed in (${about.join(', ')})` : 'Signed in',
      };
    },
  },
  codex: {
    label: 'Codex CLI',
    command: 'codex',
    args: ['login', 'status'],
    install: 'npm install -g @openai/codex',
    signIn: 'codex login (on a headless host: codex login --device-auth)',
    read({ code, stdout, stderr = '' }) {
      // It prints "Logged in using ChatGPT" or "Logged in using an API key
      // - sk-…" to stderr, among any warnings. Keep the method, drop the key.
      const method = `${stdout}\n${stderr}`
        .split('\n')
        .map(
          (text) =>
            /^Logged in using (?:an? )?(.+?)(?: - .*)?$/.exec(text.trim())?.[1],
        )
        .find((text) => text !== undefined);
      return {
        signedIn: code === 0,
        detail: method ? `Signed in (${method})` : 'Signed in',
      };
    },
  },
};

/** The command that signs `provider`'s CLI in. */
export function signInHint(provider: Provider): string {
  return CLIS[provider].signIn;
}

/** `provider`'s CLI by name, such as `Claude Code CLI`. */
export function cliLabel(provider: Provider): string {
  return CLIS[provider].label;
}

/** The command that installs `provider`'s CLI. */
export function installHint(provider: Provider): string {
  return CLIS[provider].install;
}

/**
 * Asks `provider`'s CLI whether it is signed in, as the account running
 * this process. Never reports who is signed in, only how.
 */
export async function checkProviderAuth(
  provider: Provider,
  options: CheckOptions = {},
): Promise<ProviderAuthResult> {
  const cli = CLIS[provider];
  const timeoutMs = options.timeoutMs ?? AUTH_CHECK_TIMEOUT_MS;
  const outcome = await (options.exec ?? execCommand)(cli.command, cli.args, {
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (outcome.error?.code === 'ENOENT') {
    return {
      state: 'unconfigured',
      detail: `${cli.label} not found — install it with ${cli.install}, then run ${cli.signIn}`,
      installed: false,
    };
  }
  if (outcome.error && outcome.code === null) {
    const reason = outcome.error.killed
      ? `${cli.command} did not answer within ${timeoutMs / 1000} s`
      : outcome.error.message;
    return {
      state: 'degraded',
      detail: `Could not check sign-in: ${reason}`,
      installed: true,
    };
  }

  let read;
  try {
    read = cli.read(outcome);
  } catch {
    return {
      state: 'degraded',
      detail: `Could not check sign-in: unexpected output from ${cli.command}`,
      installed: true,
    };
  }
  return read.signedIn
    ? { state: 'ok', detail: read.detail ?? 'Signed in', installed: true }
    : {
        state: 'unconfigured',
        detail: `Not signed in — run ${cli.signIn}`,
        installed: true,
      };
}

/** Runs a command with `execFile`, never rejecting. */
export const execCommand: Exec = (command, args, { timeoutMs, signal }) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, signal, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : null;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
          ...(error && code === null
            ? { error: error as NonNullable<ExecOutcome['error']> }
            : {}),
        });
      },
    );
  });
