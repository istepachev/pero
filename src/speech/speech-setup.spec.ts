import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEECH, type SpeechConfig } from '../config/host-config.js';
import { PIPER_VOICE, WHISPER_MODEL } from './speech-models.js';
import { downloadModel, speechSetupPlan } from './speech-setup.js';

describe('pero speech setup', () => {
  let workspace: string;
  let speech: SpeechConfig;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pero-speech-setup-'));
    speech = structuredClone(DEFAULT_SPEECH);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('lists the programs and default models the local engine needs', () => {
    const ffmpeg = join(workspace, 'ffmpeg');
    writeFileSync(ffmpeg, '#!/bin/sh\n');
    chmodSync(ffmpeg, 0o755);
    speech.programs = {
      ffmpeg,
      whisper: 'pero-no-such-whisper',
      piper: 'pero-no-such-piper',
    };

    const plan = speechSetupPlan(speech, workspace);

    expect(plan.programs.map(({ program, path }) => [program, path])).toEqual([
      [ffmpeg, ffmpeg],
      ['pero-no-such-whisper', null],
      ['pero-no-such-piper', null],
    ]);
    expect(plan.downloads).toEqual([WHISPER_MODEL, ...PIPER_VOICE]);
    expect(plan.missing).toEqual([]);
    expect(plan.elevenLabs).toBe(false);
  });

  it('skips what is there, and names model files config.yaml names', () => {
    const models = join(workspace, '.pero', 'models');
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, WHISPER_MODEL.name), '');
    speech.speak.voice = 'voices/de.onnx';

    const plan = speechSetupPlan(speech, workspace);

    expect(plan.downloads).toEqual([]);
    expect(plan.missing).toEqual([
      join(workspace, 'voices/de.onnx'),
      join(workspace, 'voices/de.onnx.json'),
    ]);
  });

  it('needs nothing local for ElevenLabs or off', () => {
    speech.transcribe.engine = 'elevenlabs';
    speech.speak.engine = 'off';

    expect(speechSetupPlan(speech, workspace)).toEqual({
      programs: [],
      downloads: [],
      missing: [],
      elevenLabs: true,
    });
  });

  it('downloads a model into place, and leaves nothing of a failed one', async () => {
    const folder = join(workspace, 'models');
    const ok = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('weights')),
    );

    const path = await downloadModel(WHISPER_MODEL, folder, ok);

    expect(ok).toHaveBeenCalledWith(WHISPER_MODEL.url);
    expect(path).toBe(join(folder, WHISPER_MODEL.name));
    expect(readFileSync(path, 'utf8')).toBe('weights');

    const missing = () => Promise.resolve(new Response('', { status: 404 }));
    await expect(
      downloadModel(PIPER_VOICE[0]!, folder, missing),
    ).rejects.toThrow(`Failed to download ${PIPER_VOICE[0]!.url}: 404`);
    expect(() =>
      readFileSync(join(folder, `${PIPER_VOICE[0]!.name}.part`)),
    ).toThrow();
  });
});
