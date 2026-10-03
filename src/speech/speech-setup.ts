import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import type { SpeechConfig } from '../config/host-config.js';
import { workspaceLayout } from '../config/workspace-layout.js';
import { INSTALL_HINTS, type LocalPrograms } from './local-engine.js';
import { findProgram } from './run-program.js';
import {
  type ModelFile,
  PIPER_VOICE,
  piperVoicePath,
  WHISPER_MODEL,
  whisperModelPath,
} from './speech-models.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** A program the `local` engine runs, and where it was found. */
export interface ProgramCheck {
  /** As `config.yaml` names it. */
  program: string;
  /** Where it runs from; null when it isn't installed. */
  path: string | null;
  /** How to install it. */
  hint: string;
}

/** What `pero speech configure` finds to do for `speech`. */
export interface SpeechSetupPlan {
  /** The programs the `local` engine needs, in the order they're named. */
  programs: ProgramCheck[];
  /** Default models missing from `.pero/models/`, which it can fetch. */
  downloads: ModelFile[];
  /** Model files `config.yaml` names that aren't there. */
  missing: string[];
  /** Whether an ElevenLabs engine is on, so it needs a key. */
  elevenLabs: boolean;
}

/** What `speech` needs in `workspace` that setup can check or fetch. */
export function speechSetupPlan(
  speech: SpeechConfig,
  workspace: string,
): SpeechSetupPlan {
  const transcribe = speech.transcribe.engine === 'local';
  const speak = speech.speak.engine === 'local';
  const needed = new Set<keyof LocalPrograms>([
    ...(transcribe ? (['ffmpeg', 'whisper'] as const) : []),
    ...(speak ? (['ffmpeg', 'piper'] as const) : []),
  ]);
  const programs = [...needed].map((key) => {
    const program = speech.programs[key];
    return { program, path: findProgram(program), hint: INSTALL_HINTS[key] };
  });
  const downloads: ModelFile[] = [];
  const missing: string[] = [];
  const models = workspaceLayout(workspace).models;
  if (transcribe) {
    const model = whisperModelPath(speech, workspace);
    if (speech.transcribe.model !== null) {
      if (!existsSync(model)) missing.push(model);
    } else if (!existsSync(join(models, WHISPER_MODEL.name))) {
      downloads.push(WHISPER_MODEL);
    }
  }
  if (speak) {
    const voice = piperVoicePath(speech, workspace);
    if (speech.speak.voice !== null) {
      for (const file of [voice, `${voice}.json`]) {
        if (!existsSync(file)) missing.push(file);
      }
    } else {
      downloads.push(
        ...PIPER_VOICE.filter((file) => !existsSync(join(models, file.name))),
      );
    }
  }
  return {
    programs,
    downloads,
    missing,
    elevenLabs:
      speech.transcribe.engine === 'elevenlabs' ||
      speech.speak.engine === 'elevenlabs',
  };
}

/**
 * Downloads `file` into `folder`, through a `.part` file renamed into
 * place once complete, so a broken download never looks finished.
 * Resolves to where it is.
 */
export async function downloadModel(
  file: ModelFile,
  folder: string,
  fetchFile: typeof fetch = fetch,
): Promise<string> {
  await mkdir(folder, { recursive: true });
  const target = join(folder, file.name);
  const partial = `${target}.part`;
  const response = await fetchFile(file.url);
  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download ${file.url}: ${response.status}`);
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      createWriteStream(partial, { mode: 0o600 }),
    );
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return target;
}
