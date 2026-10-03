import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import { InvalidInputError } from '../../common/errors.js';
import { SPEECH_ENGINES, type SpeechEngine } from '../../config/host-config.js';
import { elevenLabsKey } from '../../speech/speech-readiness.js';
import { CliError } from '../errors.js';
import { PeroCommand } from '../pero-command.js';
import {
  isInteractive,
  isPromptExit,
  readStdin,
  terminalPrompts,
} from '../prompts.js';
import { BlockOutput } from '../setup/block-output.js';
import {
  configureSpeech,
  formatSpeechStatus,
  readSpeech,
  type SpeechChoices,
  speechNeedsSetup,
} from '../setup/configure-speech.js';

@SubCommand({
  name: 'status',
  description:
    'Show whether Pero can transcribe and record voice messages, offering to set them up',
  options: { isDefault: true },
})
export class SpeechStatusCommand extends PeroCommand {
  async run(): Promise<void> {
    const layout = this.layout();
    const output = new BlockOutput((text) => console.log(text));
    output.print(
      formatSpeechStatus(
        readSpeech(layout),
        layout.workspace,
        elevenLabsKey(layout.workspace),
      ),
    );
    if (!speechNeedsSetup(layout)) return;
    if (!isInteractive()) {
      output.print('On a terminal, pero speech configure sets this up.');
      return;
    }
    const prompts = output.prompts(await terminalPrompts());
    output.block();
    await cancellable(async () => {
      if (
        await prompts.confirm({
          message: 'Set up voice messages now?',
          initial: true,
        })
      ) {
        await configureSpeech({
          layout,
          prompts,
          print: output.print,
          block: output.block,
        });
      }
    });
  }
}

@SubCommand({
  name: 'configure',
  aliases: ['setup'],
  description:
    'Choose how Pero transcribes voice messages and records its own, and set that up',
})
export class SpeechConfigureCommand extends PeroCommand {
  async run(_arguments: string[], options: SpeechChoices = {}): Promise<void> {
    const layout = this.layout();
    const output = new BlockOutput((text) => console.log(text));
    if (isInteractive()) {
      const prompts = output.prompts(await terminalPrompts());
      await cancellable(() =>
        configureSpeech(
          { layout, prompts, print: output.print, block: output.block },
          options,
        ),
      );
      return;
    }
    if (
      options.transcribe === undefined &&
      options.speak === undefined &&
      options.yes !== true
    ) {
      throw new CliError(
        'Without a terminal, say what to set: --transcribe and --speak (local, elevenlabs, or off), and --yes to download the local models',
      );
    }
    await configureSpeech(
      {
        layout,
        prompts: null,
        print: output.print,
        block: output.block,
        readKey: readStdin,
      },
      options,
    );
  }

  @Option({
    flags: '--transcribe <engine>',
    description:
      'how to transcribe voice messages you send: local, elevenlabs, or off',
  })
  parseTranscribe(value: string): SpeechEngine {
    return engine('transcribe', value);
  }

  @Option({
    flags: '--speak <engine>',
    description:
      'how to record voice messages Pero sends: local, elevenlabs, or off',
  })
  parseSpeak(value: string): SpeechEngine {
    return engine('speak', value);
  }

  @Option({
    flags: '-y, --yes',
    description: 'download the local models without asking',
  })
  parseYes(): boolean {
    return true;
  }
}

@Command({
  name: 'speech',
  description:
    'Show, set up, and change how Pero transcribes voice messages and records its own',
  subCommands: [SpeechStatusCommand, SpeechConfigureCommand],
})
export class SpeechCommand extends CommandRunner {
  // `status` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}

function engine(option: string, value: string): SpeechEngine {
  if ((SPEECH_ENGINES as readonly string[]).includes(value)) {
    return value as SpeechEngine;
  }
  throw new InvalidInputError(
    `${option}: must be one of ${SPEECH_ENGINES.join(', ')}`,
  );
}

/** Runs `ask`; Ctrl-C or Ctrl-D at a question cancels the command. */
async function cancellable(ask: () => Promise<void>): Promise<void> {
  try {
    await ask();
  } catch (error) {
    if (isPromptExit(error)) throw new CliError('Cancelled', 130);
    throw error;
  }
}
