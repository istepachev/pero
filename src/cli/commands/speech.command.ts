import { homedir } from 'node:os';
import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import { ensureGitignoreLine, setEnvValue } from '../../config/env-file.js';
import {
  DEFAULT_SPEECH,
  readHostConfig,
  type SpeechConfig,
} from '../../config/host-config.js';
import { ELEVENLABS_KEY_ENV } from '../../speech/elevenlabs-engine.js';
import { downloadModel, speechSetupPlan } from '../../speech/speech-setup.js';
import {
  elevenLabsKey,
  speakProblem,
  transcribeProblem,
} from '../../speech/speech-readiness.js';
import { CliError } from '../errors.js';
import { PeroCommand } from '../pero-command.js';
import { isInteractive, isPromptExit, terminalPrompts } from '../prompts.js';

@SubCommand({
  name: 'status',
  description: 'Show whether Pero can transcribe and record voice messages',
  options: { isDefault: true },
})
export class SpeechStatusCommand extends PeroCommand {
  run(): Promise<void> {
    const { workspace, configFile } = this.layout();
    console.log(formatSpeechStatus(readSpeech(configFile), workspace));
    return Promise.resolve();
  }
}

@SubCommand({
  name: 'setup',
  description:
    'Check the programs voice messages need, fetch the local models, and store an ElevenLabs key',
})
export class SpeechSetupCommand extends PeroCommand {
  async run(
    _arguments: string[],
    options: { yes?: boolean } = {},
  ): Promise<void> {
    const layout = this.layout();
    const speech = readSpeech(layout.configFile);
    const plan = speechSetupPlan(speech, layout.workspace);
    const interactive = isInteractive();
    console.log(
      `Transcribe: ${speech.transcribe.engine}\nSpeak: ${speech.speak.engine}`,
    );

    if (plan.programs.length > 0) {
      console.log('\nPrograms:');
      for (const { program, path, hint } of plan.programs) {
        console.log(
          path === null
            ? `  ✗ ${program} isn't installed: ${hint}`
            : `  ✓ ${program} (${path})`,
        );
      }
    }
    for (const file of plan.missing) {
      console.log(`\n✗ ${file} is missing; config.yaml names it.`);
    }

    if (plan.downloads.length > 0) {
      const total = plan.downloads.reduce((sum, file) => sum + file.sizeMb, 0);
      const names = plan.downloads.map((file) => file.name).join(', ');
      const download =
        options.yes === true ||
        (interactive &&
          (await ask((prompts) =>
            prompts.confirm({
              message: `Download ${names} (about ${Math.round(total)} MB) to ${layout.models}?`,
              initial: true,
            }),
          )));
      if (download) {
        for (const file of plan.downloads) {
          process.stdout.write(`\nDownloading ${file.name}… `);
          await downloadModel(file, layout.models);
          process.stdout.write('done');
        }
        console.log('');
      } else {
        console.log(
          `\nModels to download: ${names}. Run pero speech setup --yes to fetch them.`,
        );
      }
    }

    if (plan.elevenLabs && elevenLabsKey(layout.workspace) === null) {
      if (interactive) {
        const key = (
          await ask((prompts) =>
            prompts.password({ message: 'ElevenLabs API key' }),
          )
        ).trim();
        if (key !== '') {
          setEnvValue(layout.envFile, ELEVENLABS_KEY_ENV, key);
          ensureGitignoreLine(layout.workspaceGitignore, '.env');
          console.log(`Stored ${ELEVENLABS_KEY_ENV} in .env`);
        }
      } else {
        console.log(
          `\nSet ${ELEVENLABS_KEY_ENV} in ${layout.envFile} to use ElevenLabs.`,
        );
      }
    }

    console.log(`\n${formatSpeechStatus(speech, layout.workspace)}`);
  }

  @Option({
    flags: '-y, --yes',
    description: 'download the models without asking',
  })
  parseYes(): boolean {
    return true;
  }
}

@Command({
  name: 'speech',
  description:
    'Show and set up how Pero transcribes voice messages and records its own',
  subCommands: [SpeechStatusCommand, SpeechSetupCommand],
})
export class SpeechCommand extends CommandRunner {
  // `status` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}

/** `speech` from `config.yaml`, or the defaults when there is none. */
function readSpeech(configFile: string): SpeechConfig {
  return readHostConfig(configFile)?.speech ?? DEFAULT_SPEECH;
}

/** Whether each direction works, and why not when it doesn't. */
export function formatSpeechStatus(
  speech: SpeechConfig,
  workspace: string,
  key: string | null = elevenLabsKey(workspace),
  home: string = homedir(),
): string {
  const line = (name: string, engine: string, problem: string | null): string =>
    `${name}: ${engine}, ${problem === null ? 'ready' : problem.replaceAll(home, '~')}`;
  return [
    line(
      'Voice messages you send',
      speech.transcribe.engine,
      transcribeProblem(speech, workspace, key),
    ),
    line(
      'Voice messages Pero sends',
      speech.speak.engine,
      speakProblem(speech, workspace, key),
    ),
  ].join('\n');
}

/** Asks with the terminal's prompts; Ctrl-C cancels the command. */
async function ask<T>(
  question: (
    prompts: Awaited<ReturnType<typeof terminalPrompts>>,
  ) => Promise<T>,
): Promise<T> {
  try {
    return await question(await terminalPrompts());
  } catch (error) {
    if (isPromptExit(error)) throw new CliError('Cancelled', 130);
    throw error;
  }
}
