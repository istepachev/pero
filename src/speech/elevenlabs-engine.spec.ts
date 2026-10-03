import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkElevenLabsKey,
  ElevenLabsSynthesizer,
  ElevenLabsTranscriber,
  listElevenLabsVoices,
} from './elevenlabs-engine.js';
import { SpeechError } from './speech-engine.js';

const KEY = 'sk_test_secret';

describe('the ElevenLabs engine', () => {
  let folder: string;
  let voice: string;
  const signal = new AbortController().signal;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pero-elevenlabs-'));
    voice = join(folder, 'voice.ogg');
    writeFileSync(voice, 'ogg bytes');
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('transcribes a file with its model and language', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ text: ' Hello there. ' })),
    );
    const transcriber = new ElevenLabsTranscriber({
      key: () => KEY,
      model: 'scribe_v1',
      language: 'en',
      apiRoot: 'https://eleven.test',
      fetch,
    });

    await expect(
      transcriber.transcribe({ path: voice, type: 'audio/ogg' }, signal),
    ).resolves.toBe('Hello there.');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://eleven.test/v1/speech-to-text');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'xi-api-key': KEY });
    const form = init?.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('language_code')).toBe('en');
    const file = form.get('file') as File;
    expect(file.name).toBe('voice.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(await file.text()).toBe('ogg bytes');
  });

  it('speaks with a voice and model, as MP3', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
    );
    const synthesizer = new ElevenLabsSynthesizer({
      key: () => KEY,
      voice: 'voice/1',
      model: 'eleven_multilingual_v2',
      apiRoot: 'https://eleven.test',
      fetch,
    });

    await expect(synthesizer.synthesize('Hi.', signal)).resolves.toEqual({
      audio: new Uint8Array([1, 2, 3]),
      type: 'audio/mpeg',
      durationS: null,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      'https://eleven.test/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128',
    );
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'xi-api-key': KEY,
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      text: 'Hi.',
      model_id: 'eleven_multilingual_v2',
    });
  });

  it('says why a request failed, never with the key', async () => {
    const answer = (response: Response | Error) =>
      new ElevenLabsSynthesizer({
        key: () => KEY,
        voice: 'v',
        model: 'm',
        fetch: () =>
          response instanceof Error
            ? Promise.reject(response)
            : Promise.resolve(response),
      }).synthesize('Hi.', signal);

    await expect(
      answer(
        Response.json(
          {
            detail: { status: 'invalid_api_key', message: 'Invalid API key.' },
          },
          { status: 401 },
        ),
      ),
    ).rejects.toThrow(
      new SpeechError('ElevenLabs answered 401: Invalid API key'),
    );
    await expect(answer(new Response('busy', { status: 503 }))).rejects.toThrow(
      new SpeechError('ElevenLabs answered 503'),
    );
    const offline = answer(new TypeError(`fetch failed for ${KEY}`));
    await expect(offline).rejects.toThrow(
      new SpeechError('ElevenLabs is unreachable'),
    );
  });

  it('needs a key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      new ElevenLabsSynthesizer({
        key: () => null,
        voice: 'v',
        model: 'm',
        fetch,
      }).synthesize('Hi.', signal),
    ).rejects.toThrow(
      new SpeechError('no ElevenLabs API key is set; run pero speech'),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks a key, saying invalid only when ElevenLabs does', async () => {
    const answering = (response: Response | Error) => ({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve(response),
      ),
    });
    const valid = answering(Response.json({ subscription: {} }));

    await expect(checkElevenLabsKey(KEY, valid)).resolves.toBe('valid');
    expect(valid.fetch.mock.calls[0]![0]).toBe(
      'https://api.elevenlabs.io/v1/user',
    );
    expect(valid.fetch.mock.calls[0]![1]?.headers).toEqual({
      'xi-api-key': KEY,
    });
    await expect(
      checkElevenLabsKey(
        KEY,
        answering(
          Response.json(
            { detail: { status: 'invalid_api_key' } },
            { status: 401 },
          ),
        ),
      ),
    ).resolves.toBe('invalid');
    await expect(
      checkElevenLabsKey(
        KEY,
        answering(
          Response.json(
            { detail: { status: 'missing_permissions' } },
            { status: 401 },
          ),
        ),
      ),
    ).resolves.toBe('unknown');
    await expect(
      checkElevenLabsKey(KEY, answering(new TypeError('offline'))),
    ).resolves.toBe('unknown');
  });

  it("lists the account's voices by name, described by their labels", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json({
          voices: [
            {
              voice_id: 'v2',
              name: 'Rachel',
              category: 'premade',
              labels: { accent: 'american', gender: 'female' },
            },
            { voice_id: 'v1', name: 'My clone', category: 'cloned' },
            { name: 'No ID' },
          ],
        }),
      ),
    );

    await expect(listElevenLabsVoices(KEY, { fetch })).resolves.toEqual([
      { id: 'v1', name: 'My clone', description: '(cloned)' },
      { id: 'v2', name: 'Rachel', description: 'american, female (premade)' },
    ]);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.elevenlabs.io/v1/voices');
  });
});
