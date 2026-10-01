import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { InvalidInputError } from '../../common/errors.js';
import { TELEGRAM_TOKEN_ENV } from '../../config/settings-input.js';
import type { SettingsChange } from '../../config/settings-input.js';
import type { ControlClient } from '../../control/client.js';
import { SETTING_HOMES } from '../../settings-files/note-hints.js';
import { CliError } from '../errors.js';
import { formatSettings, formatToken } from '../format-settings.js';
import { settingStub } from '../note-stubs.js';
import { PeroCommand } from '../pero-command.js';
import { isPromptExit, readStdin, terminalPrompts } from '../prompts.js';

/** The one setting Pero stores itself; notes and `config.yaml` hold the rest. */
const TOKEN_KEY = 'telegram-bot-token';

/** Every key `pero settings` knows: the old ones name where they live now. */
const KEYS = [...Object.keys(SETTING_HOMES), TOKEN_KEY];

const KEY_LIST = KEYS.join(', ');

@SubCommand({
  name: 'show',
  description: 'Show the installation settings',
  options: { isDefault: true },
})
export class SettingsShowCommand extends PeroCommand {
  async run(): Promise<void> {
    const { client } = await this.requireDaemon();
    console.log(formatSettings(await client.call('settings.get')));
  }
}

@SubCommand({
  name: 'set',
  arguments: '<key> [value]',
  description:
    'Set the Telegram bot token, read from the prompt or stdin; other settings are in Pero.md and config.yaml, and this says where',
  argsDescription: { key: KEY_LIST },
})
export class SettingsSetCommand extends PeroCommand {
  async run([name, value]: string[]): Promise<void> {
    checkKey(name!);
    settingStub(this.config(), name!);
    if (value !== undefined) {
      // The value is not repeated: it is already in the shell history.
      throw new CliError(
        `Pass ${TOKEN_KEY} on stdin or at the prompt, not as an argument, so it stays out of shell history`,
      );
    }
    const { client } = await this.requireDaemon();
    const token = await readToken();
    if (token.trim() === '')
      throw new CliError(`No value given for ${TOKEN_KEY}`);
    await apply(client, { telegramBotToken: token });
  }
}

@SubCommand({
  name: 'unset',
  arguments: '<key>',
  description:
    'Delete the stored Telegram bot token; other settings are in Pero.md and config.yaml, and this says where',
  argsDescription: { key: KEY_LIST },
})
export class SettingsUnsetCommand extends PeroCommand {
  async run([name]: string[]): Promise<void> {
    checkKey(name!);
    settingStub(this.config(), name!);
    const { client } = await this.requireDaemon();
    await apply(client, { telegramBotToken: null });
  }
}

@Command({
  name: 'settings',
  description: 'Show the installation settings, or set the Telegram bot token',
  subCommands: [SettingsShowCommand, SettingsSetCommand, SettingsUnsetCommand],
})
export class SettingsCommand extends CommandRunner {
  // `show` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}

/**
 * A `CliError` listing the valid keys unless `name` is one. `settingStub`
 * then stops at any but the bot token, naming where it lives now.
 */
function checkKey(name: string): void {
  if (!KEYS.includes(name)) {
    throw new CliError(`Unknown setting "${name}". Settings: ${KEY_LIST}`);
  }
}

/** Sends `change`, then prints where the token now comes from. */
async function apply(
  client: ControlClient,
  change: SettingsChange,
): Promise<void> {
  let view;
  try {
    view = await client.call('settings.update', change);
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error;
    // The daemon names the field as it stores it.
    throw new InvalidInputError(
      error.message.replace(/^telegramBotToken: /, `${TOKEN_KEY}: `),
    );
  }
  console.log(`${TOKEN_KEY} is now ${formatToken(view)}`);
  if (view.telegramBotToken.source === 'environment') {
    console.error(
      `${TELEGRAM_TOKEN_ENV} overrides the stored token while it is set`,
    );
  }
}

/** The token from the prompt on a terminal, otherwise all of stdin. */
async function readToken(): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  const prompts = await terminalPrompts();
  try {
    return await prompts.password({ message: TOKEN_KEY });
  } catch (error) {
    if (isPromptExit(error)) throw new CliError('Cancelled', 130);
    throw error;
  }
}
