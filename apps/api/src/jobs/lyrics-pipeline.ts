import { Injectable, Logger } from '@nestjs/common';
import { LyricsAlignmentService } from '../alignment/lyrics-alignment.service';
import { LyricsService } from '../lyrics/lyrics.service';
import { TrackRepository } from '../track/track.repository';
import { TrackTranscriptionService } from '../transcription/track-transcription.service';
import { TranscriptionError } from '../transcription/transcription.errors';
import { AttemptContext, JobQueue, LyricsJobPayload } from './job-queues';

/**
 * Orchestrates: fetch -> transcribe -> align. Each stage is a separate, idempotent job.
 * None of this ever touches playback: a failure only sets the track's lyrics status.
 */
@Injectable()
export class LyricsPipeline {
  private readonly logger = new Logger(LyricsPipeline.name);

  constructor(
    private readonly queue: JobQueue,
    private readonly lyrics: LyricsService,
    private readonly transcription: TrackTranscriptionService,
    private readonly alignment: LyricsAlignmentService,
    private readonly tracks: TrackRepository,
  ) {}

  /** Entry point for discovery and for the admin "process lyrics" action. */
  async start(trackId: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.tracks.setLyricsStatus(trackId, 'LYRICS_PENDING');
    await this.queue.enqueueLyricsFetch({ trackId, force: opts.force });
  }

  async handleFetch(p: LyricsJobPayload, ctx: AttemptContext): Promise<void> {
    await this.guard(p.trackId, ctx, async () => {
      await this.tracks.setLyricsStatus(p.trackId, 'LYRICS_PROCESSING');
      const res = await this.lyrics.fetchForTrack(p.trackId, { force: p.force });
      if (res.kind === 'NO_URL') return this.tracks.setLyricsStatus(p.trackId, 'LYRICS_NONE');
      if (res.kind === 'FAILED') return this.tracks.setLyricsStatus(p.trackId, 'LYRICS_FAILED', res.reason);
      if (!(await this.transcription.isEnabled())) {
        // Whisper not configured: raw lyrics stay available, sync is simply off (not an error).
        return this.tracks.setLyricsStatus(p.trackId, 'LYRICS_NONE', 'SYNC_DISABLED');
      }
      await this.queue.enqueueTranscription({ trackId: p.trackId, force: p.force });
    });
  }

  async handleTranscribe(p: LyricsJobPayload, ctx: AttemptContext): Promise<void> {
    await this.guard(p.trackId, ctx, async () => {
      const res = await this.transcription.transcribeTrack(p.trackId, { force: p.force });
      if (res.kind === 'DISABLED') return this.tracks.setLyricsStatus(p.trackId, 'LYRICS_NONE', 'SYNC_DISABLED');
      if (res.kind === 'TRACK_MISSING') return;
      await this.queue.enqueueAlignment({ trackId: p.trackId, transcriptId: res.transcriptId });
    });
  }

  async handleAlign(p: LyricsJobPayload, ctx: AttemptContext): Promise<void> {
    await this.guard(p.trackId, ctx, async () => {
      if (!p.transcriptId) return this.tracks.setLyricsStatus(p.trackId, 'LYRICS_FAILED', 'NO_TRANSCRIPT');
      const res = await this.alignment.alignTrack(p.trackId, p.transcriptId);
      if (res.kind === 'ALIGNED') return this.tracks.setLyricsStatus(p.trackId, 'LYRICS_READY');
      return this.tracks.setLyricsStatus(p.trackId, 'LYRICS_FAILED', res.reason);
    });
  }

  /**
   * Retryable errors are rethrown (queue retries with backoff) until the last attempt, where the track is marked
   * LYRICS_FAILED. Non-retryable errors fail immediately and are swallowed so the queue does not retry data problems.
   */
  private async guard(trackId: string, ctx: AttemptContext, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const retryable = !(err instanceof TranscriptionError) || err.retryable;
      const message = err instanceof Error ? err.message : String(err);
      if (retryable && !ctx.isLastAttempt) {
        this.logger.warn({ msg: 'lyrics job failed, will retry', trackId, err: message });
        throw err;
      }
      this.logger.error({ msg: 'lyrics job failed permanently', trackId, err: message });
      await this.tracks.setLyricsStatus(trackId, 'LYRICS_FAILED', message.slice(0, 200));
      if (retryable) throw err; // surface final failure to the queue for observability
    }
  }
}
