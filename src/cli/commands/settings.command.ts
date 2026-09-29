import { homedir } from 'node:os';
import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { InvalidInputError } from '../../common/errors.js';
import { TELEGRAM_TOKEN_ENV } from '../../config/settings-input.js';
import type { SettingsChange } from '../../config/settings-input.js';
import type { ControlClient } from '../../control/client.js';
import { CliError } from '../errors.js';
import { formatSettings } from '../format-settings.js';
import { PeroCommand } from '../pero-command.js';
import { isPromptExit, readStdin, terminalPrompts } from '../prompts.js';
import {
  findSettingsKey,
  renameField,
  SETTINGS_KEYS,
  type SettingsKey,
} from '../settings-keys.js';

const KEY_LIST = SETTINGS_KEYS.map((key) => key.name).join(', ');

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
    'Change a setting; without a value it is read from the prompt or stdin',
  argsDescription: { key: KEY_LIST },
})
export class SettingsSetCommand extends PeroCommand {
  async run([name, value]: string[]): Promise<void> {
    const key = findSettingsKey(name!);
    if (key.secret && value !== undefined) {
      // The value is not repeated: it is already in the shell history.
      throw new CliError(
        `Pass ${key.name} on stdin or at the prompt, not as an argument, so it stays out of shell history`,
      );
    }
    const { client } = await this.requireDaemon();
    const input = value ?? (await readValue(key));
    if (input.trim() === '') {
      throw new CliError(`No value given for ${key.name}`);
    }

    const change = key.set(input, { cwd: process.cwd(), home: homedir() });
    await apply(client, key, change);
  }
}

@SubCommand({
  name: 'unset',
  arguments: '<key>',
  description:
    'Clear a setting: provider options return to the provider default',
  argsDescription: { key: KEY_LIST },
})
export class SettingsUnsetCommand extends PeroCommand {
  async run([name]: string[]): Promise<void> {
    const key = findSettingsKey(name!);
    if (typeof key.unset === 'string') throw new CliError(key.unset);
    const { client } = await this.requireDaemon();
    await apply(client, key, key.unset);
  }
}

@Command({
  name: 'settings',
  description: 'Show or change the installation settings',
  subCommands: [SettingsShowCommand, SettingsSetCommand, SettingsUnsetCommand],
})
export class SettingsCommand extends CommandRunner {
  // `show` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}

/** Sends `change`, then prints the new value of `key`. */
async function apply(
  client: ControlClient,
  key: SettingsKey,
  change: SettingsChange,
): Promise<void> {
  let view;
  try {
    view = await client.call('settings.update', change);
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error;
    throw new InvalidInputError(renameField(error.message, key));
  }
  console.log(`${key.name} is now ${key.show(view)}`);
  const note = typeof key.note === 'function' ? key.note(view) : key.note;
  if (note !== undefined && note !== null) console.log(note);
  if (key.secret && view.telegramBotToken.source === 'environment') {
    console.error(
      `${TELEGRAM_TOKEN_ENV} overrides the stored token while it is set`,
    );
  }
}

/** A value from the prompt on a terminal, otherwise all of stdin. */
async function readValue(key: SettingsKey): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  const prompts = await terminalPrompts();
  try {
    return key.secret
      ? await prompts.password({ message: key.name })
      : await prompts.input({ message: key.name });
  } catch (error) {
    if (isPromptExit(error)) throw new CliError('Cancelled', 130);
    throw error;
  }
}
