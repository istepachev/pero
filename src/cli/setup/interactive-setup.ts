import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidInputError } from '../../common/errors.js';
import { resolvePath } from '../../config/bootstrap-config.js';
import { PROVIDERS } from '../../config/provider-options.js';
import type { ControlClient } from '../../control/client.js';
import type { SettingsView, StatusResult } from '../../control/protocol.js';
import type { Prompts } from '../prompts.js';
import { formatPendingSetup, pendingSetup } from './pending-setup.js';

export interface SetupContext {
  client: ControlClient;
  prompts: Prompts;
  /** Where `pero run` was started; the suggested working folder. */
  cwd: string;
  home: string;
  print: (text: string) => void;
}

export interface SetupState {
  status: StatusResult;
  settings: SettingsView;
}

/**
 * Guides the owner through what `pero run` found missing: the folder all
 * Agents share, the Telegram bot token, and provider sign-in. Every answer
 * goes to the daemon at once, so an interrupted setup keeps what was done.
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
  await checkProviders(context, settings, status);

  // Fresh: the answers above changed what the daemon reports.
  const pending = pendingSetup(await context.client.status(), settings);
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
        ? ` (change with pero settings set default-provider ${other})`
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
