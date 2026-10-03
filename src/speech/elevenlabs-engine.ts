import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type AudioFile,
  type SpeechAudio,
  SpeechError,
  type Synthesizer,
  type Transcriber,
} from './speech-engine.js';

/** ElevenLabs' API; tests point it elsewhere. */
export const ELEVENLABS_API_ROOT = 'https://api.elevenlabs.io';

/** Where the API key is read: the environment, or the workspace's `.env`. */
export const ELEVENLABS_KEY_ENV = 'ELEVENLABS_API_KEY';

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 120_000;

interface ElevenLabsOptions {
  /** The API key, looked up for each request so a new one applies at once. */
  key: () => string | null;
  model: string;
  apiRoot?: string;
  fetch?: typeof fetch;
}

/** Transcribes with ElevenLabs' speech-to-text, which reads OGG directly. */
export class ElevenLabsTranscriber implements Transcriber {
  constructor(
    private readonly options: ElevenLabsOptions & {
      /** Such as `en`; null to detect the language. */
      language: string | null;
    },
  ) {}

  async transcribe(file: AudioFile, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('model_id', this.options.model);
    if (this.options.language !== null) {
      form.append('language_code', this.options.language);
    }
    form.append('tag_audio_events', 'false');
    form.append(
      'file',
      new Blob([await readFile(file.path)], { type: file.type }),
      basename(file.path),
    );
    const response = await request(this.options, '/v1/speech-to-text', {
      method: 'POST',
      body: form,
      signal,
    });
    const body = (await response.json()) as { text?: unknown };
    if (typeof body.text !== 'string') {
      throw new SpeechError('ElevenLabs answered without a transcript');
    }
    return body.text.trim();
  }
}

/** Speaks with ElevenLabs' text-to-speech, as MP3. */
export class ElevenLabsSynthesizer implements Synthesizer {
  constructor(
    private readonly options: ElevenLabsOptions & { voice: string },
  ) {}

  async synthesize(text: string, signal: AbortSignal): Promise<SpeechAudio> {
    const voice = encodeURIComponent(this.options.voice);
    const response = await request(
      this.options,
      `/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: this.options.model }),
        signal,
      },
    );
    return {
      audio: new Uint8Array(await response.arrayBuffer()),
      type: 'audio/mpeg',
      durationS: null,
    };
  }
}

/**
 * Sends a request to ElevenLabs with the key, and resolves to a
 * successful response. Throws a `SpeechError` naming what went wrong,
 * never with the key.
 */
async function request(
  options: ElevenLabsOptions,
  path: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  const key = options.key();
  if (key === null) {
    throw new SpeechError(`${ELEVENLABS_KEY_ENV} is not set in .env`);
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${options.apiRoot ?? ELEVENLABS_API_ROOT}${path}`,
      {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          'xi-api-key': key,
        },
        signal: AbortSignal.any([
          init.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      },
    );
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `took longer than ${REQUEST_TIMEOUT_MS / 1000} s`
        : 'is unreachable';
    throw new SpeechError(`ElevenLabs ${reason}`);
  }
  if (!response.ok) {
    throw new SpeechError(
      `ElevenLabs answered ${response.status}${await problemOf(response)}`,
    );
  }
  return response;
}

/** `: <message>` from an ElevenLabs error, or nothing when it has none. */
async function problemOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      detail?: { message?: unknown } | string;
    };
    const message =
      typeof body.detail === 'string' ? body.detail : body.detail?.message;
    return typeof message === 'string' && message !== ''
      ? `: ${message.replace(/\.$/, '')}`
      : '';
  } catch {
    return '';
  }
}
