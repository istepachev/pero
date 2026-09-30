import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidInputError } from '../../common/errors.js';
import { resolvePath } from '../../config/bootstrap-config.js';
import { PROVIDERS } from '../../config/provider-options.js';
import type { ControlClient } from '../../control/client.js';
import type {
  PairingRequestView,
  SettingsView,
  StatusResult,
  TelegramChats,
} from '../../control/protocol.js';
import {
  describe,
  formatAllowed,
  pairingSteps,
} from '../format-telegram-chats.js';
import { isPromptAbort, type Prompts } from '../prompts.js';
import {
  fetchTelegramChats,
  formatPendingSetup,
  pendingSetup,
} from './pending-setup.js';

/** How often setup asks the daemon whether a chat has asked to pair. */
const PAIRING_POLL_MS = 1000;

/** How long setup waits for the bot to connect before moving on. */
const CONNECT_WAIT_MS = 15_000;

export interface SetupContext {
  client: ControlClient;
  prompts: Prompts;
  /** Where `pero run` was started; the suggested working folder. */
  cwd: string;
  home: string;
  print: (text: string) => void;
  /** How often to ask the daemon about Telegram chats; for tests. */
  pollIntervalMs?: number;
}

export interface SetupState {
  status: StatusResult;
  settings: SettingsView;
}

/**
 * Guides the owner through what `pero run` found missing: the folder all
 * Agents share, the Telegram bot token and a first chat to serve, and
 * provider sign-in. Every answer goes to the daemon at once, so an
 * interrupted setup keeps what was done.
 */
export async function runInteractiveSetup(
  context: SetupContext,
  initial: SetupState,
): Promise<void> {
  const { status } = initial;
  let { settings } = initial;
  if (settings.defaultWorkingDirectory === null) {
    settings = await askWorkingDirectory(context);
  }
  const token = settings.telegramBotToken;
  if (!token.set && token.source !== 'environment') {
    settings = await askTelegramToken(context, settings);
  }
  if (settings.telegramBotToken.set) await pairChat(context);
  await checkProviders(context, settings, status);

  // Fresh: the answers above changed what the daemon reports.
  const pending = pendingSetup(
    await context.client.status(),
    settings,
    await fetchTelegramChats(context.client),
  );
  context.print(
    pending.length === 0
      ? 'Setup complete'
      : formatPendingSetup(pending, 'Run pero run again to finish setting up.'),
  );
}

async function askWorkingDirectory(
  context: SetupContext,
): Promise<SettingsView> {
  const { client, prompts, cwd, home, print } = context;
  const suggested = cwd === home ? join(home, 'workspace') : cwd;
  print(
    'Choose the folder all Agents work in, such as a notes vault. ' +
      'An Agent can get its own folder later.',
  );
  for (;;) {
    const answer = await prompts.input({
      message: 'Working folder',
      initial: suggested,
    });
    const folder = resolvePath(answer.trim() || suggested, cwd, home);
    if (!existsSync(folder)) {
      try {
        mkdirSync(folder, { recursive: true });
      } catch (error) {
        print(`Cannot create ${folder}: ${(error as Error).message}`);
        continue;
      }
      print(`Created ${folder}`);
    }
    try {
      return await client.call('settings.update', {
        defaultWorkingDirectory: folder,
      });
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
      print(error.message);
    }
  }
}

async function askTelegramToken(
  context: SetupContext,
  settings: SettingsView,
): Promise<SettingsView> {
  const { client, prompts, print } = context;
  print(
    'Pero talks to you through a Telegram bot. Create one with @BotFather ' +
      '(/newbot) and paste the token it gives you.',
  );
  for (;;) {
    const token = (
      await prompts.password({ message: 'Bot token (Enter to skip)' })
    ).trim();
    if (!token) {
      print('Skipped; set it later with pero settings set telegram-bot-token');
      return settings;
    }
    try {
      return await client.call('settings.update', { telegramBotToken: token });
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
      // The daemon's message names the field; the token itself is never echoed.
      print(
        'That is not a bot token from @BotFather (such as 123456789:AAE…); try again.',
      );
    }
  }
}

/**
 * While no chat is allowed, waits for one to message the bot and offers to
 * allow it. Enter skips; a chat the owner declines is not offered again.
 */
async function pairChat(context: SetupContext): Promise<void> {
  const { client, prompts, print } = context;
  let chats = await fetchTelegramChats(client);
  if (chats === null || chats.allowed.length > 0) return;
  print('Now pair a Telegram chat, where you will talk to Pero.');
  if (chats.bot === null) {
    print('Waiting for Telegram…');
    chats = await waitForBot(context);
    if (chats === null) {
      print(
        "Telegram isn't connected yet (see pero status); allow a chat later with pero telegram allow <chat-id>",
      );
      return;
    }
    if (chats.allowed.length > 0) return;
  }
  for (const step of pairingSteps(chats.bot)) print(`  ${step}`);

  const declined = new Set<string>();
  for (;;) {
    const request = await waitForRequest(context, `@${chats.bot}`, declined);
    if (request === 'allowed') return;
    if (request === null) {
      print(
        'Skipped; the bot tells a chat it does not serve its ID — allow it with pero telegram allow <chat-id>',
      );
      return;
    }
    const allow = await prompts.confirm({
      message: `Allow ${describe(request)}?`,
      initial: true,
    });
    if (!allow) {
      declined.add(request.chatId);
      continue;
    }
    const { chat } = await client.call('telegram.allow', {
      chatId: request.chatId,
    });
    print(formatAllowed(chat, false));
    print('Send a message there again to start talking to Pero.');
    return;
  }
}

/** Telegram's chats once the bot is connected; null if that takes long. */
async function waitForBot(
  context: SetupContext,
): Promise<TelegramChats | null> {
  const interval = context.pollIntervalMs ?? PAIRING_POLL_MS;
  for (let waited = 0; waited < CONNECT_WAIT_MS; waited += interval) {
    await delay(interval);
    const chats = await context.client.call('telegram.chats');
    if (chats.bot !== null) return chats;
  }
  return null;
}

/**
 * The first chat that asks to pair and is not in `declined`; null when the
 * owner presses Enter first, and `allowed` when a chat was allowed some
 * other way meanwhile, such as with `pero telegram allow`.
 */
async function waitForRequest(
  context: SetupContext,
  bot: string,
  declined: ReadonlySet<string>,
): Promise<PairingRequestView | 'allowed' | null> {
  const { client, prompts } = context;
  const interval = context.pollIntervalMs ?? PAIRING_POLL_MS;
  const found = (chats: TelegramChats) =>
    chats.allowed.length > 0
      ? 'allowed'
      : (chats.pairing.find((request) => !declined.has(request.chatId)) ??
        null);

  const now = found(await client.call('telegram.chats'));
  if (now !== null) return now;

  const waiting = new AbortController();
  let result: PairingRequestView | 'allowed' | null = null;
  let failure: unknown = null;
  const polling = (async () => {
    try {
      while (!waiting.signal.aborted) {
        await delay(interval);
        if (waiting.signal.aborted) return;
        result = found(await client.call('telegram.chats'));
        if (result !== null) waiting.abort();
      }
    } catch (error) {
      failure = error;
      waiting.abort();
    }
  })();
  let skipped = false;
  try {
    await prompts.input({
      message: `Waiting for a message to ${bot} (Enter to skip)`,
      signal: waiting.signal,
    });
    skipped = true;
  } catch (error) {
    if (!isPromptAbort(error)) throw error;
  } finally {
    waiting.abort();
    await polling;
  }
  if (failure !== null) throw failure;
  return skipped ? null : result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkProviders(
  context: SetupContext,
  settings: SettingsView,
  initial: StatusResult,
): Promise<void> {
  const { client, prompts, print } = context;
  let status = initial;
  const component = (name: string) =>
    status.components.find((candidate) => candidate.name === name);

  const other = PROVIDERS.find((p) => p !== settings.defaultProvider);
  print(
    `Default provider: ${settings.defaultProvider}` +
      (other && settings.files !== null
        ? ` (change with provider: ${other} in ${settings.files.pero})`
        : ''),
  );
  for (const provider of PROVIDERS) {
    let checked = false;
    for (;;) {
      const state = component(provider);
      if (!state?.required) break;
      if (state.state === 'ok') {
        if (checked) print(`${provider}: ${state.detail ?? 'ok'}`);
        break;
      }
      print(`${provider}: ${state.detail ?? state.state}`);
      const answer = await prompts.input({
        message:
          'Sign in in another terminal, then press Enter to check again (s to skip)',
      });
      if (answer.trim().toLowerCase() === 's') break;
      status = await client.call('providers.check');
      checked = true;
    }
  }
}
