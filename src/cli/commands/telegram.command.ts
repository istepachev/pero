import { mkdirSync } from 'node:fs';
import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { InvalidInputError } from '../../common/errors.js';
import {
  TELEGRAM_TOKEN_ENV,
  telegramBotTokenSchema,
} from '../../config/settings-input.js';
import { storeTelegramToken } from '../../config/token-file.js';
import type { AllowedChatView } from '../../control/protocol.js';
import { allowInFile, denyInFile } from '../allowlist-file.js';
import { CliError } from '../errors.js';
import { formatToken } from '../format-settings.js';
import {
  describe,
  formatAllowed,
  formatTelegramChats,
} from '../format-telegram-chats.js';
import { PeroCommand } from '../pero-command.js';
import { isPromptExit, readStdin, terminalPrompts } from '../prompts.js';

const CHAT_ID = {
  'chat-id':
    "a group's ID (negative, such as -1001234567890) or a person's user ID; the bot tells a chat it does not serve its ID",
};

@SubCommand({
  name: 'chats',
  description: 'List allowed chats and chats that recently asked to pair',
  options: { isDefault: true },
})
export class TelegramChatsCommand extends PeroCommand {
  async run(): Promise<void> {
    const { client } = await this.requireDaemon();
    console.log(formatTelegramChats(await client.call('telegram.chats')));
  }
}

// Unknown options are allowed so that a group's negative ID is taken as
// the argument rather than as an option.
@SubCommand({
  name: 'allow',
  arguments: '<chat-id>',
  description: 'Let a Telegram group or direct chat reach Pero',
  argsDescription: CHAT_ID,
  allowUnknownOptions: true,
})
export class TelegramAllowCommand extends PeroCommand {
  async run([chatId]: string[]): Promise<void> {
    const client = await this.runningDaemon();
    if (client === null) {
      const { chat, alreadyAllowed } = allowInFile(this.layout(), chatId!);
      console.log(`${describeAllowed(chat, alreadyAllowed)}\n${NOT_RUNNING}`);
      return;
    }
    const { chat, alreadyAllowed } = await withChatId(() =>
      client.call('telegram.allow', { chatId: chatId! }),
    );
    console.log(formatAllowed(chat, alreadyAllowed));
  }
}

@SubCommand({
  name: 'deny',
  arguments: '<chat-id>',
  description:
    'Stop serving a Telegram chat, keeping its Channels and Agents for when it is allowed again',
  argsDescription: CHAT_ID,
  allowUnknownOptions: true,
})
export class TelegramDenyCommand extends PeroCommand {
  async run([chatId]: string[]): Promise<void> {
    const client = await this.runningDaemon();
    const { chat } =
      client === null
        ? denyInFile(this.layout(), chatId!)
        : await withChatId(() =>
            client.call('telegram.deny', { chatId: chatId! }),
          );
    console.log(
      `Denied: ${describe(chat)}. Its Channels and Agents are kept and resume if you allow it again.` +
        (client === null ? `\n${NOT_RUNNING}` : ''),
    );
  }
}

// The argument is declared only to refuse it.
@SubCommand({
  name: 'token',
  arguments: '[token]',
  description:
    'Set the Telegram bot token from @BotFather, read from a hidden prompt or stdin',
  argsDescription: {
    token: 'refused: give it at the prompt or on stdin, out of shell history',
  },
})
export class TelegramTokenCommand extends PeroCommand {
  async run([argument]: string[]): Promise<void> {
    if (argument !== undefined) {
      // The value is not repeated: it is already in the shell history.
      throw new CliError(
        'Give the bot token at the prompt or on stdin, not as an argument, so it stays out of shell history',
      );
    }
    const token = checkToken(await readToken());
    const client = await this.runningDaemon();
    if (client === null) {
      const layout = this.layout();
      mkdirSync(layout.workspace, { recursive: true });
      storeTelegramToken(
        { envFile: layout.envFile, gitignore: layout.workspaceGitignore },
        token,
      );
      console.log(
        "Telegram bot token: set (.env)\nPero isn't running; it uses the token when it starts.",
      );
      return;
    }
    const view = await client.call('telegram.token', { token });
    console.log(`Telegram bot token: ${formatToken(view)}`);
    if (view.source === 'environment') {
      console.error(
        `${TELEGRAM_TOKEN_ENV} overrides the stored token while it is set`,
      );
    }
  }
}

@Command({
  name: 'telegram',
  description:
    'Show and change which Telegram chats Pero serves, and set the bot token',
  subCommands: [
    TelegramChatsCommand,
    TelegramAllowCommand,
    TelegramDenyCommand,
    TelegramTokenCommand,
  ],
})
export class TelegramCommand extends CommandRunner {
  // `chats` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}

/** Said when `allow` or `deny` edited `config.yaml` itself. */
const NOT_RUNNING =
  "Pero isn't running; the change is in config.yaml and applies when it starts.";

function describeAllowed(chat: AllowedChatView, alreadyAllowed: boolean) {
  return `${alreadyAllowed ? 'Already allowed' : 'Allowed'}: ${describe(chat)}`;
}

/** Runs `call`, naming the chat ID as the command's argument does. */
async function withChatId<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error;
    throw new InvalidInputError(error.message.replace(/^chatId:/, 'chat-id:'));
  }
}

/** The token from a hidden prompt on a terminal, otherwise all of stdin. */
async function readToken(): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  const prompts = await terminalPrompts();
  try {
    return await prompts.password({ message: 'Bot token' });
  } catch (error) {
    if (isPromptExit(error)) throw new CliError('Cancelled', 130);
    throw error;
  }
}

/** `input`, trimmed, when it is a bot token; never repeated when not. */
function checkToken(input: string): string {
  if (input.trim() === '') throw new CliError('No bot token given');
  const parsed = telegramBotTokenSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidInputError(`token: ${parsed.error.issues[0]!.message}`);
  }
  return parsed.data;
}
