export interface StagedAudio {
  /** A local file Whisper can read (mono FLAC at the requested sample rate). */
  filePath: string;
  /** Removes the temporary files (idempotent). */
  dispose(): Promise<void>;
}

/** Gets a track's audio out of Telegram and into a form the speech-to-text provider accepts. */
export abstract class AudioStaging {
  abstract stage(input: { trackId: string; channelId: string; messageId: number; sampleRate: number }, signal?: AbortSignal): Promise<StagedAudio>;
}
