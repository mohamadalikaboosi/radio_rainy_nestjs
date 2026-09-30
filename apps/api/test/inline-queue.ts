import { JobQueue, LyricsJobPayload } from '../src/jobs/job-queues';
import { LyricsPipeline } from '../src/jobs/lyrics-pipeline';

interface Job {
  stage: 'fetch' | 'transcribe' | 'align' | 'sync';
  payload: LyricsJobPayload;
}

/** Runs jobs in-process, in order, with the same attempt semantics as the real queue (retries + isLastAttempt). */
export class InlineQueue implements JobQueue {
  jobs: Job[] = [];
  history: string[] = [];
  pipeline!: LyricsPipeline;
  onSync?: () => Promise<void>;
  constructor(private readonly maxAttempts = 3) {}

  async enqueueLyricsFetch(payload: LyricsJobPayload): Promise<void> {
    this.jobs.push({ stage: 'fetch', payload });
  }
  async enqueueTranscription(payload: LyricsJobPayload): Promise<void> {
    this.jobs.push({ stage: 'transcribe', payload });
  }
  async enqueueAlignment(payload: LyricsJobPayload & { transcriptId: string }): Promise<void> {
    this.jobs.push({ stage: 'align', payload });
  }
  async enqueueTelegramSync(): Promise<void> {
    this.jobs.push({ stage: 'sync', payload: { trackId: '' } });
  }

  async drain(): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (!job) break;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        this.history.push(`${job.stage}#${attempt}`);
        try {
          const ctx = { isLastAttempt: attempt === this.maxAttempts };
          if (job.stage === 'fetch') await this.pipeline.handleFetch(job.payload, ctx);
          else if (job.stage === 'transcribe') await this.pipeline.handleTranscribe(job.payload, ctx);
          else if (job.stage === 'align') await this.pipeline.handleAlign(job.payload, ctx);
          else await this.onSync?.();
          break;
        } catch {
          if (attempt === this.maxAttempts) break;
        }
      }
    }
  }
}
