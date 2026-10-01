import { InvalidInputError } from '../../common/errors.js';
import { PROVIDERS } from '../../config/provider-options.js';
import type { ControlClient } from '../../control/client.js';
import type {
  AllowedChatView,
  PairingRequestView,
  SettingsView,
  StatusResult,
  TelegramChats,
} from '../../control/protocol.js';
import {
  describe,
  formatAllowed,
  needsAdmin,
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
  print: (text: string) => void;
  /** How often to ask the daemon about Telegram chats; for tests. */
  pollIntervalMs?: number;
}

export interface SetupState {
  status: StatusResult;
  settings: SettingsView;
}

/**
 * Guides the owner through what `pero run` found missing: the Telegram bot
 * token, a first chat to serve, the bot as an administrator of each allowed
 * group, each such group private, and provider sign-in. Every answer goes
 * to the daemon at once, so an interrupted setup keeps what was done.
 */
export async function runInteractiveSetup(
  context: SetupContext,
  initial: SetupState,
): Promise<void> {
  const { status } = initial;
  let { settings } = initial;
  const token = settings.telegramBotToken;
  if (!token.set && token.source !== 'environment') {
    settings = await askTelegramToken(context, settings);
  }
  if (settings.telegramBotToken.set) {
    const paired = await pairChat(context);
    await checkGroups(context, paired);
    if (paired !== null) {
      context.print('Send a message there again to start talking to Pero.');
    }
  }
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
      print('Skipped; set it later with pero telegram token');
      return settings;
    }
    try {
      const telegramBotToken = await client.call('telegram.token', { token });
      return { ...settings, telegramBotToken };
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
 * Returns the ID of the chat allowed here, if any.
 */
async function pairChat(context: SetupContext): Promise<string | null> {
  const { client, prompts, print } = context;
  let chats = await fetchTelegramChats(client);
  if (chats === null || chats.allowed.length > 0) return null;
  print('Now pair a Telegram chat, where you will talk to Pero.');
  if (chats.bot === null) {
    print('Waiting for Telegram…');
    chats = await waitForBot(context);
    if (chats === null) {
      print(
        "Telegram isn't connected yet (see pero status); allow a chat later with pero telegram allow <chat-id>",
      );
      return null;
    }
    if (chats.allowed.length > 0) return null;
  }
  for (const step of pairingSteps(chats.bot)) print(`  ${step}`);
  print(
    'A private group is safest: anyone who can write in an allowed chat can talk to its Agents.',
  );

  const declined = new Set<string>();
  for (;;) {
    const request = await waitForRequest(context, `@${chats.bot}`, declined);
    if (request === 'allowed') return null;
    if (request === null) {
      print(
        'Skipped; the bot tells a chat it does not serve its ID — allow it with pero telegram allow <chat-id>',
      );
      return null;
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
    return chat.chatId;
  }
}

/**
 * Has the owner make the bot an administrator of each allowed group where
 * Telegram says it is not, and make each public one private. `described`
 * is a chat whose problems were just printed.
 */
async function checkGroups(
  context: SetupContext,
  described: string | null,
): Promise<void> {
  const chats = await fetchTelegramChats(context.client);
  if (chats === null || chats.bot === null) return;
  for (const chat of chats.allowed) {
    if (chat.kind !== 'group') continue;
    const current = await requireAdmin(context, `@${chats.bot}`, chat);
    if (current !== null) {
      await requirePrivate(context, current, current.chatId !== described);
    }
  }
}

/**
 * Waits for the bot to become an administrator of `chat`, as Telegram tells
 * the daemon at once. Returns the chat as it stands then; null when it is
 * no longer allowed.
 */
async function requireAdmin(
  context: SetupContext,
  bot: string,
  chat: AllowedChatView,
): Promise<AllowedChatView | null> {
  if (!needsAdmin(chat)) return chat;
  const { print } = context;
  print(
    chat.bot === 'left'
      ? `${bot} is not in ${describe(chat)}: add it to the group as an administrator.`
      : `Make ${bot} an administrator of ${describe(chat)} (group settings → Administrators → Add Admin), so it sees every message there.`,
  );
  const found = (chats: TelegramChats) => {
    const now = chats.allowed.find((other) => other.chatId === chat.chatId);
    if (now === undefined) return 'denied' as const;
    return needsAdmin(now) ? null : now;
  };
  const result = await waitFor(
    context,
    `Waiting for ${bot} to become an administrator (Enter to skip)`,
    found,
  );
  if (result === 'denied') return null;
  if (result === null) {
    print(
      `Skipped; until ${bot} is an administrator, Telegram shows it only commands, mentions, and replies there.`,
    );
    return chat;
  }
  print(`${bot} is an administrator of ${describe(result)}.`);
  return result;
}

/**
 * Has the owner make public group `chat` private, checking again on Enter.
 * `explain` prints the danger first.
 */
async function requirePrivate(
  context: SetupContext,
  chat: AllowedChatView,
  explain: boolean,
): Promise<void> {
  const { client, prompts, print } = context;
  let current = chat;
  if (current.danger === null) return;
  if (explain) print(`Danger: ${current.danger}`);
  while (current.danger !== null) {
    const answer = await prompts.input({
      message:
        'Make the group private, then press Enter to check again (s to skip)',
    });
    if (answer.trim().toLowerCase() === 's') {
      print(
        `Skipped; anyone can still join ${describe(current)}. Make it private, or pero telegram deny ${current.chatId}`,
      );
      return;
    }
    // Allowing an allowed chat changes nothing but checks it again.
    ({ chat: current } = await client.call('telegram.allow', {
      chatId: current.chatId,
    }));
    if (current.danger !== null) print(`Still public: ${describe(current)}`);
  }
  print(`${describe(current)} is private now.`);
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
function waitForRequest(
  context: SetupContext,
  bot: string,
  declined: ReadonlySet<string>,
): Promise<PairingRequestView | 'allowed' | null> {
  return waitFor(
    context,
    `Waiting for a message to ${bot} (Enter to skip)`,
    (chats) =>
      chats.allowed.length > 0
        ? 'allowed'
        : (chats.pairing.find((request) => !declined.has(request.chatId)) ??
          null),
  );
}

/**
 * Asks the daemon for Telegram's chats until `found` makes something of
 * them, showing `message` meanwhile; null when the owner presses Enter
 * first.
 */
async function waitFor<T>(
  context: SetupContext,
  message: string,
  found: (chats: TelegramChats) => T | null,
): Promise<T | null> {
  const { client, prompts } = context;
  const interval = context.pollIntervalMs ?? PAIRING_POLL_MS;

  const now = found(await client.call('telegram.chats'));
  if (now !== null) return now;

  const waiting = new AbortController();
  let result: T | null = null;
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
    await prompts.input({ message, signal: waiting.signal });
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
      (other
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
