import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePath } from '../config/bootstrap-config.js';
import type { SpeechConfig } from '../config/host-config.js';
import { workspaceLayout } from '../config/workspace-layout.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** A file the `local` engine needs, and where `pero speech configure` gets it. */
export interface ModelFile {
  /** Its name in `.pero/models/`. */
  name: string;
  url: string;
  /** Roughly, for the download prompt. */
  sizeMb: number;
}

/** whisper.cpp's base model: multilingual, and quick enough on a small VPS. */
export const WHISPER_MODEL: ModelFile = {
  name: 'ggml-base.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  sizeMb: 148,
};

const PIPER_VOICES =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium';

/** A Piper voice: the model, and the settings file Piper reads beside it. */
export const PIPER_VOICE: readonly ModelFile[] = [
  {
    name: 'en_US-lessac-medium.onnx',
    url: `${PIPER_VOICES}/en_US-lessac-medium.onnx`,
    sizeMb: 63,
  },
  {
    name: 'en_US-lessac-medium.onnx.json',
    url: `${PIPER_VOICES}/en_US-lessac-medium.onnx.json`,
    sizeMb: 0.01,
  },
];

/**
 * ElevenLabs' defaults: its transcription model, a stock voice, and a model.
 * The voice is George, one of ElevenLabs' default voices; setup saves the
 * voice the owner picks, so this only speaks when none was picked.
 */
export const ELEVENLABS_DEFAULTS = {
  transcribeModel: 'scribe_v1',
  voice: 'JBFqnCBsd6RMkjVDRZzb',
  speakModel: 'eleven_multilingual_v2',
} as const;

/** The whisper.cpp model the `local` engine transcribes with. */
export function whisperModelPath(
  speech: SpeechConfig,
  workspace: string,
  home: string = homedir(),
): string {
  const model = speech.transcribe.model;
  return model === null
    ? join(workspaceLayout(workspace).models, WHISPER_MODEL.name)
    : resolvePath(model, workspace, home);
}

/** The Piper voice the `local` engine speaks with. */
export function piperVoicePath(
  speech: SpeechConfig,
  workspace: string,
  home: string = homedir(),
): string {
  const voice = speech.speak.voice;
  return voice === null
    ? join(workspaceLayout(workspace).models, PIPER_VOICE[0]!.name)
    : resolvePath(voice, workspace, home);
}
