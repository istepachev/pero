/*
 * The speech engines' contract: one turns a voice message into text, the
 * other text into a voice message. Each engine in `config.yaml`'s `speech`
 * implements one or both; the rest of Pero sees only these shapes.
 */

/** Recorded speech, ready to send as a voice message. */
export interface SpeechAudio {
  audio: Uint8Array;
  /** OGG with Opus, or MP3: what Telegram plays as a voice message. */
  type: 'audio/ogg' | 'audio/mpeg';
  /** Its length in seconds; null when the engine doesn't say. */
  durationS: number | null;
}

/** A saved voice message, audio file, or video note to transcribe. */
export interface AudioFile {
  path: string;
  /** Its media type, such as `audio/ogg`. */
  type: string;
}

export interface Transcriber {
  /** The words spoken in `file`; empty when there are none. */
  transcribe(file: AudioFile, signal: AbortSignal): Promise<string>;
}

export interface Synthesizer {
  /** `text`, spoken. */
  synthesize(text: string, signal: AbortSignal): Promise<SpeechAudio>;
}

/**
 * Why speech failed, worded to show the owner, such as `whisper-cli isn't
 * installed`. Never carries an API key.
 */
export class SpeechError extends Error {
  override name = 'SpeechError';
}
