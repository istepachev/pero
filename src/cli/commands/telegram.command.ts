import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { InvalidInputError } from '../../common/errors.js';
import type { AllowedChatView } from '../../control/protocol.js';
import { allowInFile, denyInFile } from '../allowlist-file.js';
import {
  describe,
  formatAllowed,
  formatTelegramChats,
} from '../format-telegram-chats.js';
import { PeroCommand } from '../pero-command.js';

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

@Command({
  name: 'telegram',
  description: 'Show and change which Telegram chats Pero serves',
  subCommands: [
    TelegramChatsCommand,
    TelegramAllowCommand,
    TelegramDenyCommand,
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
