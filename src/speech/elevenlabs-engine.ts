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

/** Said when an ElevenLabs engine has no key. */
export const ELEVENLABS_NO_KEY =
  'no ElevenLabs API key is set; run pero speech';

/** Where the owner makes ElevenLabs API keys and changes what they may do. */
export const ELEVENLABS_KEYS_URL =
  'https://elevenlabs.io/app/settings/api-keys';

/**
 * The permissions an ElevenLabs API key needs for each thing Pero does, as
 * ElevenLabs' key settings name them. `user` only lets setup check a key.
 */
export const ELEVENLABS_PERMISSIONS = {
  speak: 'Text to Speech',
  transcribe: 'Speech to Text',
  voices: 'Voices: Read',
  user: 'User',
} as const;

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 120_000;

/** How long checking a key or listing voices may take. */
const LOOKUP_TIMEOUT_MS = 15_000;

/** Where ElevenLabs is, and how to reach it; tests replace both. */
export interface ElevenLabsClient {
  apiRoot?: string;
  fetch?: typeof fetch;
}

interface ElevenLabsOptions extends ElevenLabsClient {
  /** The API key, looked up for each request so a new one applies at once. */
  key: () => string | null;
  model: string;
}

/** A voice on the owner's ElevenLabs account. */
export interface ElevenLabsVoice {
  id: string;
  name: string;
  /** Such as `american, female (premade)`; empty when ElevenLabs says nothing. */
  description: string;
}

/**
 * Whether ElevenLabs takes `key`: `invalid` only when it says the key is
 * not one, `restricted` for a key without the `User` permission to read
 * the account, and `unknown` when it can't tell, such as offline.
 */
export async function checkElevenLabsKey(
  key: string,
  client: ElevenLabsClient = {},
): Promise<'valid' | 'invalid' | 'restricted' | 'unknown'> {
  try {
    const response = await (client.fetch ?? fetch)(
      `${client.apiRoot ?? ELEVENLABS_API_ROOT}/v1/user`,
      {
        headers: { 'xi-api-key': key },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    if (response.ok) return 'valid';
    if (response.status !== 401) return 'unknown';
    const body = (await response.json().catch(() => null)) as {
      detail?: { status?: unknown };
    } | null;
    switch (body?.detail?.status) {
      case 'invalid_api_key':
        return 'invalid';
      case 'missing_permissions':
        return 'restricted';
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

/**
 * The voices `key`'s account can use, premade and its own, by name.
 * Throws a `SpeechError` when ElevenLabs doesn't list them.
 */
export async function listElevenLabsVoices(
  key: string,
  client: ElevenLabsClient = {},
): Promise<ElevenLabsVoice[]> {
  const response = await request(
    { ...client, key: () => key },
    '/v1/voices',
    { method: 'GET', signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
    { permission: ELEVENLABS_PERMISSIONS.voices },
  );
  const body = (await response.json()) as {
    voices?: {
      voice_id?: unknown;
      name?: unknown;
      category?: unknown;
      labels?: Record<string, unknown> | null;
    }[];
  };
  return (body.voices ?? [])
    .filter(
      (voice) =>
        typeof voice.voice_id === 'string' && typeof voice.name === 'string',
    )
    .map((voice) => {
      const labels = [voice.labels?.accent, voice.labels?.gender].filter(
        (label): label is string => typeof label === 'string' && label !== '',
      );
      const category =
        typeof voice.category === 'string' ? ` (${voice.category})` : '';
      return {
        id: voice.voice_id as string,
        name: voice.name as string,
        description: `${labels.join(', ')}${category}`.trim(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
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
    const response = await request(
      this.options,
      '/v1/speech-to-text',
      { method: 'POST', body: form, signal },
      { permission: ELEVENLABS_PERMISSIONS.transcribe },
    );
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
    const { voice } = this.options;
    const response = await request(
      this.options,
      `/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: this.options.model }),
        signal,
      },
      {
        permission: ELEVENLABS_PERMISSIONS.speak,
        notFound: `ElevenLabs has no voice ${voice} on this account; pero speech voice picks one`,
      },
    );
    return {
      audio: new Uint8Array(await response.arrayBuffer()),
      type: 'audio/mpeg',
      durationS: null,
    };
  }
}

/** What a request needs of the key, and what its 404 means. */
interface RequestNeeds {
  /** The key's permission it needs, named when ElevenLabs refuses for it. */
  permission: string;
  /** Said for a 404, such as a missing voice. */
  notFound?: string;
}

/**
 * Sends a request to ElevenLabs with the key, and resolves to a
 * successful response. Throws a `SpeechError` naming what went wrong,
 * never with the key.
 */
async function request(
  options: ElevenLabsClient & { key: () => string | null },
  path: string,
  init: RequestInit & { signal: AbortSignal },
  needs: RequestNeeds,
): Promise<Response> {
  const key = options.key();
  if (key === null) {
    throw new SpeechError(ELEVENLABS_NO_KEY);
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
  if (response.ok) return response;
  const problem = await problemOf(response);
  if (problem.status === 'missing_permissions') {
    throw new SpeechError(missingPermission(needs.permission));
  }
  if (response.status === 404 && needs.notFound !== undefined) {
    throw new SpeechError(needs.notFound);
  }
  throw new SpeechError(
    `ElevenLabs answered ${response.status}` +
      (problem.message === null ? '' : `: ${problem.message}`),
  );
}

/** Says the key lacks `permission`, and where to give it. */
function missingPermission(permission: string): string {
  return `the ElevenLabs API key lacks the "${permission}" permission; edit the key at ${ELEVENLABS_KEYS_URL}`;
}

/** An ElevenLabs error's status and message, each null when it has none. */
async function problemOf(
  response: Response,
): Promise<{ status: string | null; message: string | null }> {
  try {
    const body = (await response.json()) as {
      detail?: { status?: unknown; message?: unknown } | string;
    };
    const detail: { status?: unknown; message?: unknown } =
      typeof body.detail === 'string' ? {} : (body.detail ?? {});
    const message =
      typeof body.detail === 'string' ? body.detail : detail.message;
    return {
      status: typeof detail.status === 'string' ? detail.status : null,
      message:
        typeof message === 'string' && message !== ''
          ? message.replace(/\.$/, '')
          : null,
    };
  } catch {
    return { status: null, message: null };
  }
}
