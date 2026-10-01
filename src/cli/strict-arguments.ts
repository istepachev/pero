import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Command } from 'commander';
import { InjectCommander } from 'nest-commander';

/**
 * Makes every `pero` command refuse words it doesn't declare. Commander
 * ignores extra arguments by default, and hands a word that names no
 * subcommand to the group's default one, so `pero agents create garden`
 * would list the Agents instead of saying there is no such command.
 */
@Injectable()
export class StrictArguments implements OnApplicationBootstrap {
  constructor(@InjectCommander() private readonly program: Command) {}

  // After nest-commander has built every command, before it parses.
  onApplicationBootstrap(): void {
    refuseUnknownWords(this.program);
  }
}

/** Applies to `command` and every subcommand under it. */
export function refuseUnknownWords(command: Command): void {
  command.allowExcessArguments(false);
  command.hook('preSubcommand', (group, subcommand) => {
    const [word] = group.args;
    if (
      word === undefined ||
      word.startsWith('-') ||
      subcommand.registeredArguments.length > 0
    ) {
      return;
    }
    const known = group.commands.flatMap((sub) => [
      sub.name(),
      ...sub.aliases(),
    ]);
    if (!known.includes(word) && word !== 'help') {
      group.error(`error: unknown command '${word}'`, {
        code: 'commander.unknownCommand',
      });
    }
  });
  for (const subcommand of command.commands) refuseUnknownWords(subcommand);
}
