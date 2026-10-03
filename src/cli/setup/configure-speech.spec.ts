import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHostConfig } from '../../config/host-config.js';
import {
  type WorkspaceLayout,
  workspaceLayout,
} from '../../config/workspace-layout.js';
import { PIPER_VOICE, WHISPER_MODEL } from '../../speech/speech-models.js';
import { CliError } from '../errors.js';
import type { Prompts } from '../prompts.js';
import {
  chooseVoice,
  configureSpeech,
  offerSpeechSetup,
  type SpeechSetupContext,
  speechNeedsSetup,
} from './configure-speech.js';

type Answer = string | boolean | (() => string | boolean);

/** Answers questions in order, recording each with its kind. */
function scripted(answers: Answer[]): { prompts: Prompts; asked: string[] } {
  const asked: string[] = [];
  const next = <T>(question: string): Promise<T> => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) {
      return Promise.reject(new Error(`Unexpected question: ${question}`));
    }
    return Promise.resolve(
      (typeof answer === 'function' ? answer() : answer) as T,
    );
  };
  return {
    asked,
    prompts: {
      input: ({ message }) => next(message),
      password: ({ message }) => next(`${message} (hidden)`),
      confirm: ({ message }) => next(`${message} (y/n)`),
      select: ({ message, choices }) =>
        next(`${message} [${choices.map((choice) => choice.value).join('|')}]`),
    },
  };
}

/** ElevenLabs and Hugging Face as far as setup reaches them. */
const fetchStub = vi.fn<typeof fetch>((input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const key = (init?.headers as Record<string, string> | undefined)?.[
    'xi-api-key'
  ];
  if (key === 'restricted-key') {
    return Promise.resolve(
      Response.json(
        { detail: { status: 'missing_permissions' } },
        { status: 401 },
      ),
    );
  }
  if (url.endsWith('/v1/user')) {
    return Promise.resolve(
      key === 'good-key'
        ? Response.json({})
        : Response.json(
            { detail: { status: 'invalid_api_key' } },
            { status: 401 },
          ),
    );
  }
  if (url.endsWith('/v1/voices')) {
    return Promise.resolve(
      Response.json({
        voices: [
          { voice_id: 'v-ada', name: 'Ada', category: 'cloned' },
          { voice_id: '21m00Tcm4TlvDq8EAWfZT', name: 'Rachel' },
        ],
      }),
    );
  }
  return Promise.resolve(new Response(`model from ${url}`));
});

describe('configureSpeech', () => {
  let root: string;
  let layout: WorkspaceLayout;
  let printed: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pero-configure-speech-'));
    layout = workspaceLayout(root);
    mkdirSync(layout.stateDir);
    printed = [];
    fetchStub.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function context(prompts: Prompts | null): SpeechSetupContext {
    return {
      layout,
      prompts,
      print: (text) => printed.push(text),
      env: {},
      fetch: fetchStub,
    };
  }

  /** A program in the workspace's `bin/`, named in `config.yaml`. */
  function program(name: string): string {
    const path = join(root, 'bin', name);
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
    return path;
  }

  function useLocalPrograms(): void {
    writeFileSync(
      layout.configFile,
      [
        'speech:',
        '  programs:',
        `    ffmpeg: ${join(root, 'bin', 'ffmpeg')}`,
        `    whisper: ${join(root, 'bin', 'whisper-cli')}`,
        `    piper: ${join(root, 'bin', 'piper')}`,
        '',
      ].join('\n'),
    );
  }

  it('sets up ElevenLabs both ways: asks for a key until it works, stores it, and picks a voice', async () => {
    const { prompts, asked } = scripted([
      'elevenlabs',
      'elevenlabs',
      'bad-key',
      'good-key',
      'v-ada',
    ]);

    await configureSpeech(context(prompts));

    expect(asked).toEqual([
      'Voice messages you send: how should Pero transcribe them? [local|elevenlabs|off]',
      'Voice messages Pero sends: how should Pero record them? [local|elevenlabs|off]',
      'ElevenLabs API key (Enter to skip) (hidden)',
      'ElevenLabs API key (Enter to skip) (hidden)',
      'Which voice should Pero speak with? [v-ada|21m00Tcm4TlvDq8EAWfZT]',
    ]);
    expect(printed).toContain(
      'ElevenLabs gives you an API key at https://elevenlabs.io/app/settings/api-keys. ' +
        'Give it these permissions: Text to Speech, Voices: Read, Speech to Text, ' +
        'and optionally User so Pero can check the key. ' +
        'Pero stores it in .env, readable only by you.',
    );
    expect(printed).toContain("ElevenLabs doesn't accept that key; try again.");
    expect(readFileSync(layout.envFile, 'utf8')).toBe(
      'ELEVENLABS_API_KEY=good-key\n',
    );
    expect(statSync(layout.envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(layout.workspaceGitignore, 'utf8')).toContain('.env');
    expect(readHostConfig(layout.configFile)!.speech).toMatchObject({
      transcribe: { engine: 'elevenlabs' },
      speak: { engine: 'elevenlabs', voice: 'v-ada' },
    });
    expect(printed.at(-1)).toBe(
      'Voice messages you send: ElevenLabs, ready\n' +
        'Voice messages Pero sends: ElevenLabs, ready\n' +
        'Saved; a running Pero uses this from the next voice message.',
    );
  });

  it('stores a restricted key, saying which permissions it lacks', async () => {
    const { prompts, asked } = scripted([
      'off',
      'elevenlabs',
      'restricted-key',
    ]);

    await configureSpeech(context(prompts));

    expect(asked).toHaveLength(3);
    expect(printed).toContain(
      'ElevenLabs gives you an API key at https://elevenlabs.io/app/settings/api-keys. ' +
        'Give it these permissions: Text to Speech, Voices: Read, ' +
        'and optionally User so Pero can check the key. ' +
        'Pero stores it in .env, readable only by you.',
    );
    expect(printed).toContain(
      'The key lacks the optional "User" permission, so Pero couldn\'t check it; storing it anyway.',
    );
    expect(printed).toContain(
      'Couldn\'t list your ElevenLabs voices: the ElevenLabs API key lacks the "Voices: Read" permission; ' +
        'edit the key at https://elevenlabs.io/app/settings/api-keys. ' +
        'Pero keeps the voice it has; once they can be listed, ' +
        'pero speech voice picks one, or sets one by ID: pero speech voice <voice-id>.',
    );
    expect(readFileSync(layout.envFile, 'utf8')).toBe(
      'ELEVENLABS_API_KEY=restricted-key\n',
    );
    expect(readHostConfig(layout.configFile)!.speech.speak).toMatchObject({
      engine: 'elevenlabs',
      voice: null,
    });
  });

  it('keeps a stored key unless asked to replace it, and saves a skipped key as missing', async () => {
    writeFileSync(layout.envFile, 'ELEVENLABS_API_KEY=good-key\n', {
      mode: 0o600,
    });
    const keep = scripted(['elevenlabs', 'off', false]);
    await configureSpeech(context(keep.prompts));
    expect(keep.asked[2]).toBe(
      'An ElevenLabs API key is stored. Replace it? (y/n)',
    );

    rmSync(layout.envFile);
    const skip = scripted(['elevenlabs', 'off', '']);
    await configureSpeech(context(skip.prompts));

    expect(printed).toContain('Skipped; pero speech asks again.');
    expect(readHostConfig(layout.configFile)!.speech).toMatchObject({
      transcribe: { engine: 'elevenlabs' },
      speak: { engine: 'off' },
    });
    expect(printed.at(-1)).toContain(
      'Voice messages you send: ElevenLabs, no ElevenLabs API key is set',
    );
    expect(speechNeedsSetup(layout, {})).toBe(true);
  });

  it('checks the local programs again once installed, then downloads the models', async () => {
    useLocalPrograms();
    program('ffmpeg');
    const { prompts, asked } = scripted([
      'local',
      'local',
      () => {
        program('whisper-cli');
        program('piper');
        return 'check';
      },
      true,
    ]);

    await configureSpeech(context(prompts));

    expect(asked[2]).toBe(
      'Install the missing programs, in another terminal if you like. [check|continue]',
    );
    expect(asked[3]).toMatch(
      /^Download its models, ggml-base\.bin, en_US-lessac-medium\.onnx, en_US-lessac-medium\.onnx\.json \(about 211 MB\), to .+\/\.pero\/models\? \(y\/n\)$/,
    );
    for (const file of [WHISPER_MODEL, ...PIPER_VOICE]) {
      expect(readFileSync(join(layout.models, file.name), 'utf8')).toBe(
        `model from ${file.url}`,
      );
    }
    expect(printed.at(-1)).toMatch(
      /^Voice messages you send: Local, ready\nVoice messages Pero sends: Local, ready\n/,
    );
    expect(speechNeedsSetup(layout, {})).toBe(false);
  });

  it('switches from ElevenLabs back to local, dropping the ElevenLabs voice', async () => {
    writeFileSync(
      layout.configFile,
      'speech:\n  transcribe:\n    engine: off\n  speak:\n    engine: elevenlabs\n    voice: v-ada\n',
    );
    const { prompts } = scripted(['off', 'local', 'continue', false]);

    await configureSpeech(context(prompts));

    expect(readHostConfig(layout.configFile)!.speech.speak).toEqual({
      engine: 'local',
      voice: null,
      model: null,
    });
    expect(printed).toContain(
      'Models not downloaded; pero speech offers them again.',
    );
  });

  it('takes its answers from options without a terminal', async () => {
    await configureSpeech(context(null), { transcribe: 'off', speak: 'off' });

    expect(readHostConfig(layout.configFile)!.speech).toMatchObject({
      transcribe: { engine: 'off' },
      speak: { engine: 'off' },
    });
    expect(speechNeedsSetup(layout, {})).toBe(false);

    const piped = { ...context(null), readKey: () => Promise.resolve('bad') };
    await expect(
      configureSpeech(piped, { transcribe: 'elevenlabs' }),
    ).rejects.toThrow(new CliError("ElevenLabs doesn't accept that API key"));
    expect(existsSync(layout.envFile)).toBe(false);
  });

  it('offers setup on a first run only while speech needs it', async () => {
    const declined = scripted([false]);
    await expect(
      offerSpeechSetup({ ...context(null), prompts: declined.prompts }),
    ).resolves.toBe(false);
    expect(printed).toEqual(['Later, pero speech sets them up.']);

    await configureSpeech(context(null), { transcribe: 'off', speak: 'off' });
    const unasked = scripted([]);
    await expect(
      offerSpeechSetup({ ...context(null), prompts: unasked.prompts }),
    ).resolves.toBe(false);
    expect(unasked.asked).toEqual([]);
  });
});

describe('chooseVoice', () => {
  let root: string;
  let layout: WorkspaceLayout;
  let printed: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pero-choose-voice-'));
    layout = workspaceLayout(root);
    mkdirSync(layout.stateDir);
    printed = [];
    fetchStub.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Speaking with `engine`, with `key` stored when given. */
  function speakWith(engine: string, key?: string, voice?: string): void {
    writeFileSync(
      layout.configFile,
      `# Mine\nspeech:\n  speak:\n    engine: ${engine}\n` +
        (voice === undefined ? '' : `    voice: ${voice}\n`),
    );
    if (key !== undefined) {
      writeFileSync(layout.envFile, `ELEVENLABS_API_KEY=${key}\n`, {
        mode: 0o600,
      });
    }
  }

  function context(prompts: Prompts | null): SpeechSetupContext {
    return {
      layout,
      prompts,
      print: (text) => printed.push(text),
      env: {},
      fetch: fetchStub,
    };
  }

  const voiceSet = () => readHostConfig(layout.configFile)!.speech.speak.voice;

  it('picks a voice on a terminal and saves it, keeping comments', async () => {
    speakWith('elevenlabs', 'good-key');
    const { prompts, asked } = scripted(['v-ada']);

    await chooseVoice(context(prompts));

    expect(asked).toEqual([
      'Which voice should Pero speak with? [v-ada|21m00Tcm4TlvDq8EAWfZT]',
    ]);
    expect(voiceSet()).toBe('v-ada');
    expect(readFileSync(layout.configFile, 'utf8')).toContain('# Mine');
    expect(printed).toEqual([
      'Pero now speaks with Ada; a running Pero uses it from the next voice message.',
    ]);
  });

  it('sets a voice by ID or by name, ignoring case, and refuses one the account lacks', async () => {
    speakWith('elevenlabs', 'good-key');

    await chooseVoice(context(null), { voice: 'rachel' });
    expect(voiceSet()).toBe('21m00Tcm4TlvDq8EAWfZT');
    await chooseVoice(context(null), { voice: 'v-ada' });
    expect(voiceSet()).toBe('v-ada');
    await expect(
      chooseVoice(context(null), { voice: 'Nobody' }),
    ).rejects.toThrow(
      new CliError(
        'None of your ElevenLabs voices is Nobody; pero speech voice --list lists them',
      ),
    );
    expect(voiceSet()).toBe('v-ada');
  });

  it('lists the voices without a terminal, marking the one Pero speaks with', async () => {
    speakWith('elevenlabs', 'good-key', 'v-ada');
    const before = readFileSync(layout.configFile, 'utf8');

    await chooseVoice(context(null));
    await chooseVoice(context(scripted([]).prompts), { list: true });

    const listing = [
      '* v-ada                  Ada: (cloned)',
      '  21m00Tcm4TlvDq8EAWfZT  Rachel',
      '',
      '* the voice Pero speaks with. pero speech voice <id or name> changes it.',
    ].join('\n');
    expect(printed).toEqual([listing, listing]);
    expect(readFileSync(layout.configFile, 'utf8')).toBe(before);
  });

  it('takes a voice ID as given when the key may not list voices', async () => {
    speakWith('elevenlabs', 'restricted-key');

    await chooseVoice(context(null), { voice: 'JBFqnCBsd6RMkjVDRZzb' });

    expect(voiceSet()).toBe('JBFqnCBsd6RMkjVDRZzb');
    expect(printed[0]).toBe(
      'Couldn\'t list your ElevenLabs voices to check it: the ElevenLabs API key lacks the "Voices: Read" permission; ' +
        'edit the key at https://elevenlabs.io/app/settings/api-keys. Setting voice ID JBFqnCBsd6RMkjVDRZzb as given.',
    );
    await expect(chooseVoice(context(null))).rejects.toThrow(
      new CliError(
        'Couldn\'t list your ElevenLabs voices: the ElevenLabs API key lacks the "Voices: Read" permission; ' +
          'edit the key at https://elevenlabs.io/app/settings/api-keys. pero speech voice <voice-id> sets one by its ID',
      ),
    );
  });

  it('works only while Pero speaks with ElevenLabs, with a key', async () => {
    speakWith('local');
    await expect(chooseVoice(context(null))).rejects.toThrow(
      /^Pero speaks with the local engine, whose voice is a Piper model file/,
    );
    speakWith('off');
    await expect(chooseVoice(context(null))).rejects.toThrow(
      new CliError(
        'Voice messages Pero sends are turned off; pero speech configure turns them on',
      ),
    );
    speakWith('elevenlabs');
    await expect(chooseVoice(context(null))).rejects.toThrow(
      new CliError(
        'No ElevenLabs API key is set; pero speech configure stores one',
      ),
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
