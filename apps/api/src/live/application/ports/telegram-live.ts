import { Writable } from 'node:stream';
import { LiveQuality } from '../../domain/live-quality';

/** RTMP ingest of a Telegram channel's live stream (the "Stream with..." feature of Telegram voice chats). */
export interface RtmpTarget {
  url: string;
  key: string;
}

export interface TelegramLiveApi {
  /** Starts the channel's live stream (creating it if needed) and returns the RTMP server URL + stream key. */
  openLiveStream(channelId: string, title: string): Promise<RtmpTarget>;
  /** Ends the live stream (voice chat) of the channel. Best effort. */
  closeLiveStream(channelId: string): Promise<void>;
}

export interface PublishHooks {
  /** Called once ffmpeg has really written data to Telegram (not merely started). */
  onActive?: () => void;
  /** Every line ffmpeg printed (warnings/errors), for the log. */
  onLog?: (line: string) => void;
  /** ffmpeg's encoding speed (1.0 = exactly real time); well below 1 means the uplink cannot keep up. */
  onSpeed?: (speed: number) => void;
}

/** The process that pushes audio to Telegram. Abstracted so tests never spawn ffmpeg. */
export interface RtmpPublisher {
  /** Runs until the process exits or `signal` aborts. `input` is the MP3 radio stream. */
  publish(target: RtmpTarget, input: (sink: Writable) => () => void, signal: AbortSignal, hooks?: PublishHooks, quality?: LiveQuality): Promise<{ code: number | null; stderr: string }>;
}
