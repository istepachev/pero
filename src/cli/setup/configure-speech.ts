import { homedir } from 'node:os';
import { ensureGitignoreLine, setEnvValue } from '../../config/env-file.js';
import {
  DEFAULT_SPEECH,
  editHostConfig,
  readHostConfig,
  setSpeech,
  type SpeechConfig,
  type SpeechEngine,
} from '../../config/host-config.js';
import type { WorkspaceLayout } from '../../config/workspace-layout.js';
import {
  checkElevenLabsKey,
  ELEVENLABS_KEY_ENV,
  ELEVENLABS_KEYS_URL,
  ELEVENLABS_PERMISSIONS,
  type ElevenLabsVoice,
  listElevenLabsVoices,
} from '../../speech/elevenlabs-engine.js';
import {
  elevenLabsKey,
  speakProblem,
  transcribeProblem,
} from '../../speech/speech-readiness.js';
import { ELEVENLABS_DEFAULTS } from '../../speech/speech-models.js';
import { downloadModel, speechSetupPlan } from '../../speech/speech-setup.js';
import { CliError } from '../errors.js';
import type { Prompts } from '../prompts.js';

/** Where speech is set up, and how to talk to the owner. */
export interface SpeechSetupContext {
  layout: WorkspaceLayout;
  /** The terminal's questions; null without a terminal. */
  prompts: Prompts | null;
  print: (text: string) => void;
  /** Starts a new block of output, for the next step. */
  block?: () => void;
  /** Where `ELEVENLABS_API_KEY` may come from before `.env`. */
  env?: NodeJS.ProcessEnv;
  /** The ElevenLabs key piped in, for setup without a terminal. */
  readKey?: () => Promise<string>;
  /** ElevenLabs and model downloads go through this; tests replace it. */
  fetch?: typeof fetch;
}

/** Answers given up front, as `pero speech configure`'s options. */
export interface SpeechChoices {
  transcribe?: SpeechEngine;
  speak?: SpeechEngine;
  /** Download the local models without asking. */
  yes?: boolean;
}

const ENGINE_NAMES: Record<SpeechEngine, string> = {
  local: 'Local',
  elevenlabs: 'ElevenLabs',
  off: 'Off',
};

/**
 * `config.yaml`'s `speech`, or the defaults while it has none. Throws a
 * `ConfigError` for a file that isn't valid.
 */
export function readSpeech(layout: WorkspaceLayout): SpeechConfig {
  return readHostConfig(layout.configFile)?.speech ?? DEFAULT_SPEECH;
}

/** Whether a direction that is on can't work yet. */
export function speechNeedsSetup(
  layout: WorkspaceLayout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const speech = readSpeech(layout);
  const key = elevenLabsKey(layout.workspace, env);
  return (
    (speech.transcribe.engine !== 'off' &&
      transcribeProblem(speech, layout.workspace, key) !== null) ||
    (speech.speak.engine !== 'off' &&
      speakProblem(speech, layout.workspace, key) !== null)
  );
}

/** Whether each direction works, and why not when it doesn't. */
export function formatSpeechStatus(
  speech: SpeechConfig,
  workspace: string,
  key: string | null,
  home: string = homedir(),
): string {
  const line = (
    name: string,
    engine: SpeechEngine,
    problem: string | null,
  ): string =>
    `${name}: ${ENGINE_NAMES[engine]}, ` +
    (engine === 'off'
      ? 'turned off'
      : problem === null
        ? 'ready'
        : // This is where the hint would send the owner.
          problem.replace(/; run pero speech$/, '').replaceAll(home, '~'));
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

/**
 * Sets speech up, asking on a terminal: the engine for each direction;
 * for ElevenLabs, the API key, stored in `.env`, and the voice; for the
 * local engine, the programs it runs, checked until they're installed or
 * the owner moves on, and its models, downloaded. The engines go to
 * `config.yaml`, which a running Pero rereads within 10 seconds. Without a
 * terminal, `choices` stand in for the questions.
 */
export async function configureSpeech(
  context: SpeechSetupContext,
  choices: SpeechChoices = {},
): Promise<void> {
  const { layout, prompts, print } = context;
  const block = context.block ?? (() => undefined);
  const env = context.env ?? process.env;
  const current = readSpeech(layout);

  block();
  const transcribe =
    choices.transcribe ??
    (prompts === null
      ? current.transcribe.engine
      : await prompts.select<SpeechEngine>({
          message: 'Voice messages you send: how should Pero transcribe them?',
          choices: [
            {
              value: 'local',
              name: 'Local: free, on this machine with whisper.cpp',
            },
            { value: 'elevenlabs', name: 'ElevenLabs: paid, with an API key' },
            { value: 'off', name: "Off: Pero doesn't read voice messages" },
          ],
          initial: current.transcribe.engine,
        }));
  const speak =
    choices.speak ??
    (prompts === null
      ? current.speak.engine
      : await prompts.select<SpeechEngine>({
          message: 'Voice messages Pero sends: how should Pero record them?',
          choices: [
            { value: 'local', name: 'Local: free, on this machine with Piper' },
            {
              value: 'elevenlabs',
              name: "ElevenLabs: paid, with an API key and your account's voices",
            },
            { value: 'off', name: 'Off: Pero answers in text only' },
          ],
          initial: current.speak.engine,
        }));

  let key = elevenLabsKey(layout.workspace, env);
  let voice: string | undefined;
  if (transcribe === 'elevenlabs' || speak === 'elevenlabs') {
    block();
    key = await askKey(
      context,
      key,
      Boolean(env[ELEVENLABS_KEY_ENV]?.trim()),
      keyPermissions(transcribe, speak),
    );
    if (speak === 'elevenlabs' && key !== null && prompts !== null) {
      voice = await pickVoice(
        context,
        prompts,
        key,
        current.speak.engine === 'elevenlabs' ? current.speak.voice : null,
      );
    }
  }

  const chosen: SpeechConfig = {
    ...current,
    transcribe:
      transcribe === current.transcribe.engine
        ? current.transcribe
        : { ...current.transcribe, engine: transcribe, model: null },
    speak:
      speak === current.speak.engine
        ? { ...current.speak, ...(voice === undefined ? {} : { voice }) }
        : {
            ...current.speak,
            engine: speak,
            model: null,
            voice: voice ?? null,
          },
  };
  if (transcribe === 'local' || speak === 'local') {
    block();
    await setUpLocal(context, chosen, choices.yes === true);
  }

  editHostConfig(layout.configFile, (document) => {
    setSpeech(document, 'transcribe', transcribe);
    setSpeech(document, 'speak', speak, voice);
  });

  block();
  print(
    `${formatSpeechStatus(chosen, layout.workspace, key)}\n` +
      'Saved; a running Pero uses this from the next voice message.',
  );
}

/**
 * The ElevenLabs key to use: one in Pero's environment as it is, a stored
 * one unless the owner replaces it, or one the owner gives, checked with
 * ElevenLabs and stored in `.env`. Null when there is none.
 */
async function askKey(
  context: SpeechSetupContext,
  existing: string | null,
  fromEnvironment: boolean,
  permissions: string,
): Promise<string | null> {
  const { layout, prompts, print } = context;
  if (fromEnvironment) {
    print(
      `${ELEVENLABS_KEY_ENV} is set in the environment; Pero uses that key.`,
    );
    return existing;
  }
  if (prompts === null) {
    const piped = (await context.readKey?.())?.trim() ?? '';
    if (piped === '') {
      if (existing === null) {
        print(
          `No ElevenLabs API key: pipe one in, such as printf '%s' "$KEY" | pero speech configure …`,
        );
      }
      return existing;
    }
    if ((await checkElevenLabsKey(piped, client(context))) === 'invalid') {
      throw new CliError("ElevenLabs doesn't accept that API key");
    }
    storeKey(layout, piped, print);
    return piped;
  }
  if (
    existing !== null &&
    !(await prompts.confirm({
      message: 'An ElevenLabs API key is stored. Replace it?',
      initial: false,
    }))
  ) {
    return existing;
  }
  print(
    `ElevenLabs gives you an API key at ${ELEVENLABS_KEYS_URL}. ` +
      `Give it these permissions: ${permissions}. ` +
      'Pero stores it in .env, readable only by you.',
  );
  for (;;) {
    const key = (
      await prompts.password({ message: 'ElevenLabs API key (Enter to skip)' })
    ).trim();
    if (key === '') {
      if (existing === null) print('Skipped; pero speech asks again.');
      return existing;
    }
    const check = await checkElevenLabsKey(key, client(context));
    if (check === 'invalid') {
      print("ElevenLabs doesn't accept that key; try again.");
      continue;
    }
    if (check === 'restricted') {
      print(
        `The key lacks the optional "${ELEVENLABS_PERMISSIONS.user}" permission, so Pero couldn't check it; storing it anyway.`,
      );
    } else if (check === 'unknown') {
      print("Couldn't check the key with ElevenLabs; storing it anyway.");
    }
    storeKey(layout, key, print);
    return key;
  }
}

/** The permissions a key needs for the engines chosen, for the owner. */
function keyPermissions(transcribe: SpeechEngine, speak: SpeechEngine): string {
  const needed = [
    ...(speak === 'elevenlabs'
      ? [ELEVENLABS_PERMISSIONS.speak, ELEVENLABS_PERMISSIONS.voices]
      : []),
    ...(transcribe === 'elevenlabs' ? [ELEVENLABS_PERMISSIONS.transcribe] : []),
  ];
  return `${needed.join(', ')}, and optionally ${ELEVENLABS_PERMISSIONS.user} so Pero can check the key`;
}

function storeKey(
  layout: WorkspaceLayout,
  key: string,
  print: (text: string) => void,
): void {
  setEnvValue(layout.envFile, ELEVENLABS_KEY_ENV, key);
  ensureGitignoreLine(layout.workspaceGitignore, '.env');
  print('Stored the ElevenLabs API key in .env');
}

/**
 * The ElevenLabs voice the owner picks from their account's; undefined to
 * keep the one set, or the default, when the voices can't be listed.
 */
async function pickVoice(
  context: SpeechSetupContext,
  prompts: Prompts,
  key: string,
  current: string | null,
): Promise<string | undefined> {
  let voices;
  try {
    voices = await listElevenLabsVoices(key, client(context));
  } catch (error) {
    context.print(
      `Couldn't list your ElevenLabs voices: ${describe(error)}. ` +
        'Pero keeps the voice it has; once they can be listed, ' +
        'pero speech voice picks one, or sets one by ID: pero speech voice <voice-id>.',
    );
    return undefined;
  }
  if (voices.length === 0) return undefined;
  return askVoice(prompts, voices, current ?? ELEVENLABS_DEFAULTS.voice);
}

/** One of `voices`, starting at `current` when it is among them. */
function askVoice(
  prompts: Prompts,
  voices: ElevenLabsVoice[],
  current: string,
): Promise<string> {
  return prompts.select({
    message: 'Which voice should Pero speak with?',
    choices: voices.map((voice) => ({
      value: voice.id,
      name: voiceLabel(voice),
    })),
    initial: voices.some((voice) => voice.id === current)
      ? current
      : voices[0]!.id,
  });
}

/** A voice's name, and its description when it has one. */
function voiceLabel(voice: ElevenLabsVoice): string {
  return voice.description === ''
    ? voice.name
    : `${voice.name}: ${voice.description}`;
}

/** What `pero speech voice` is asked: a voice to set, or to list them. */
export interface VoiceChoice {
  /** A voice's ID or name; when absent, the owner picks one on a terminal. */
  voice?: string;
  /** Only list the voices. */
  list?: boolean;
}

/**
 * Lists the ElevenLabs voices Pero may speak with, or sets the one it
 * speaks with: `choice.voice` by ID or name, else the owner's pick on a
 * terminal. Without a terminal and a voice, it lists them. A voice ID is
 * taken as given when the voices can't be listed, such as for a key not
 * allowed to read them.
 */
export async function chooseVoice(
  context: SpeechSetupContext,
  choice: VoiceChoice = {},
): Promise<void> {
  const { layout, prompts, print } = context;
  const speak = readSpeech(layout).speak;
  if (speak.engine === 'local') {
    throw new CliError(
      'Pero speaks with the local engine, whose voice is a Piper model file set as speech.speak.voice in .pero/config.yaml; listing voices works with ElevenLabs, which pero speech configure switches to',
    );
  }
  if (speak.engine === 'off') {
    throw new CliError(
      'Voice messages Pero sends are turned off; pero speech configure turns them on',
    );
  }
  const key = elevenLabsKey(layout.workspace, context.env ?? process.env);
  if (key === null) {
    throw new CliError(
      'No ElevenLabs API key is set; pero speech configure stores one',
    );
  }
  const current = speak.voice ?? ELEVENLABS_DEFAULTS.voice;
  let voices: ElevenLabsVoice[] | null = null;
  let problem = '';
  try {
    voices = await listElevenLabsVoices(key, client(context));
  } catch (error) {
    problem = describe(error);
  }

  if (choice.voice !== undefined && choice.list !== true) {
    const wanted = choice.voice.trim();
    if (voices === null) {
      print(
        `Couldn't list your ElevenLabs voices to check it: ${problem}. Setting voice ID ${wanted} as given.`,
      );
      saveVoice(context, wanted, wanted);
      return;
    }
    const found = findVoice(voices, wanted);
    saveVoice(context, found.id, found.name);
    return;
  }

  if (voices === null) {
    throw new CliError(
      `Couldn't list your ElevenLabs voices: ${problem}. pero speech voice <voice-id> sets one by its ID`,
    );
  }
  if (voices.length === 0) {
    throw new CliError(
      'Your ElevenLabs account has no voices; add one at https://elevenlabs.io/app/voice-library',
    );
  }
  if (prompts === null || choice.list === true) {
    print(formatVoices(voices, current));
    return;
  }
  const id = await askVoice(prompts, voices, current);
  saveVoice(context, id, voices.find((voice) => voice.id === id)!.name);
}

/** The voice `wanted` names, by ID or else by name, ignoring case. */
function findVoice(voices: ElevenLabsVoice[], wanted: string): ElevenLabsVoice {
  const byId = voices.find((voice) => voice.id === wanted);
  if (byId !== undefined) return byId;
  const named = voices.filter(
    (voice) => voice.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new CliError(
      `Several of your ElevenLabs voices are named ${wanted}; give one's ID: ${named.map((voice) => voice.id).join(', ')}`,
    );
  }
  throw new CliError(
    `None of your ElevenLabs voices is ${wanted}; pero speech voice --list lists them`,
  );
}

/** Each voice, its ID first, with `*` at the one Pero speaks with. */
function formatVoices(voices: ElevenLabsVoice[], current: string): string {
  const width = Math.max(...voices.map((voice) => voice.id.length));
  const lines = voices.map(
    (voice) =>
      `${voice.id === current ? '*' : ' '} ${voice.id.padEnd(width)}  ${voiceLabel(voice)}`,
  );
  const note = voices.some((voice) => voice.id === current)
    ? '* the voice Pero speaks with.'
    : `Pero speaks with ${current}, which isn't among them.`;
  return [
    ...lines,
    '',
    `${note} pero speech voice <id or name> changes it.`,
  ].join('\n');
}

function saveVoice(
  context: SpeechSetupContext,
  id: string,
  name: string,
): void {
  editHostConfig(context.layout.configFile, (document) => {
    setSpeech(document, 'speak', 'elevenlabs', id);
  });
  context.print(
    `Pero now speaks with ${name}; a running Pero uses it from the next voice message.`,
  );
}

/**
 * Checks the programs the local engine runs, again while the owner
 * installs them, and downloads its models.
 */
async function setUpLocal(
  context: SpeechSetupContext,
  speech: SpeechConfig,
  yes: boolean,
): Promise<void> {
  const { layout, prompts, print } = context;
  let plan = speechSetupPlan(speech, layout.workspace);
  for (;;) {
    print(
      [
        'The local engine runs these programs on this machine:',
        ...plan.programs.map(({ program, path, hint }) =>
          path === null
            ? `  ✗ ${program} isn't installed: ${hint}`
            : `  ✓ ${program}`,
        ),
      ].join('\n'),
    );
    const missing = plan.programs.some(({ path }) => path === null);
    if (!missing || prompts === null) break;
    const next = await prompts.select<'check' | 'continue'>({
      message: 'Install the missing programs, in another terminal if you like.',
      choices: [
        { value: 'check', name: "I've installed them: check again" },
        { value: 'continue', name: 'Continue without them for now' },
      ],
      initial: 'check',
    });
    if (next === 'continue') break;
    plan = speechSetupPlan(speech, layout.workspace);
  }
  for (const file of plan.missing) {
    print(`✗ ${file} is missing.`);
  }
  if (plan.downloads.length === 0) return;
  const size = Math.round(
    plan.downloads.reduce((sum, file) => sum + file.sizeMb, 0),
  );
  const names = plan.downloads.map((file) => file.name).join(', ');
  const download =
    yes ||
    (prompts !== null &&
      (await prompts.confirm({
        message: `Download its models, ${names} (about ${size} MB), to ${layout.models}?`,
        initial: true,
      })));
  if (!download) {
    print('Models not downloaded; pero speech offers them again.');
    return;
  }
  for (const file of plan.downloads) {
    try {
      await downloadModel(file, layout.models, context.fetch);
      print(`Downloaded ${file.name}`);
    } catch (error) {
      print(`Couldn't download ${file.name}: ${describe(error)}`);
    }
  }
}

function client(context: SpeechSetupContext) {
  return context.fetch === undefined ? {} : { fetch: context.fetch };
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /\.$/,
    '',
  );
}

/**
 * On a first `pero run`, offers to set speech up when it can't work yet;
 * Enter declines. True when the owner set it up.
 */
export async function offerSpeechSetup(
  context: SpeechSetupContext & { prompts: Prompts },
): Promise<boolean> {
  if (!speechNeedsSetup(context.layout, context.env)) return false;
  context.block?.();
  const accepted = await context.prompts.confirm({
    message:
      'Set up voice messages now? Pero can then transcribe the ones you send and answer by voice.',
    initial: false,
  });
  if (!accepted) {
    context.print('Later, pero speech sets them up.');
    return false;
  }
  await configureSpeech(context);
  return true;
}
