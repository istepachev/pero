import { join } from 'node:path';
import { readEnvFile } from '../config/env-file.js';
import type { SpeechConfig } from '../config/host-config.js';
import { ELEVENLABS_KEY_ENV, ELEVENLABS_NO_KEY } from './elevenlabs-engine.js';
import { localProblem, localPrograms } from './local-engine.js';
import { piperVoicePath, whisperModelPath } from './speech-models.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * The ElevenLabs key: from `env`, else from the workspace's `.env`; null
 * when neither has one, or `.env` is refused for being readable by others.
 */
export function elevenLabsKey(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env[ELEVENLABS_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const stored = readEnvFile(join(workspace, '.env'))
      ?.get(ELEVENLABS_KEY_ENV)
      ?.trim();
    return stored || null;
  } catch {
    return null;
  }
}

/** Why voice messages can't be transcribed with `speech`; null when they can. */
export function transcribeProblem(
  speech: SpeechConfig,
  workspace: string,
  key: string | null,
): string | null {
  switch (speech.transcribe.engine) {
    case 'off':
      return 'transcription is turned off; pero speech configure turns it on';
    case 'elevenlabs':
      return keyProblem(key);
    case 'local': {
      const programs = localPrograms(speech.programs, workspace);
      return localProblem(
        [programs.ffmpeg, programs.whisper],
        [whisperModelPath(speech, workspace)],
      );
    }
  }
}

/** Why voice messages can't be recorded with `speech`; null when they can. */
export function speakProblem(
  speech: SpeechConfig,
  workspace: string,
  key: string | null,
): string | null {
  switch (speech.speak.engine) {
    case 'off':
      return 'voice messages are turned off; pero speech configure turns them on';
    case 'elevenlabs':
      return keyProblem(key);
    case 'local': {
      const voice = piperVoicePath(speech, workspace);
      const programs = localPrograms(speech.programs, workspace);
      return localProblem(
        [programs.piper, programs.ffmpeg],
        [voice, `${voice}.json`],
      );
    }
  }
}

function keyProblem(key: string | null): string | null {
  return key === null ? ELEVENLABS_NO_KEY : null;
}
