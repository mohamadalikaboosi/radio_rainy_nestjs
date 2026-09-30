import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JobsOptions, Queue, Worker, WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { TelegramFloodWaitError, TelegramNotReadyError } from '../telegram/telegram.types';
import { AttemptContext, JobQueue, LyricsJobPayload, QUEUES, QueueName, SyncJobPayload } from './job-queues';

export interface JobHandlers {
  fetch(p: LyricsJobPayload, ctx: AttemptContext): Promise<void>;
  transcribe(p: LyricsJobPayload, ctx: AttemptContext): Promise<void>;
  align(p: LyricsJobPayload, ctx: AttemptContext): Promise<void>;
  sync(p: SyncJobPayload): Promise<void>;
}

export interface BullOptions {
  redisUrl: string;
  /** Queue key prefix (isolates environments/tests). */
  prefix?: string;
  /** Scale factor for backoff delays (1 = production). Tests use a tiny value. */
  backoffScale?: number;
}

const ATTEMPTS = { fetch: 5, transcribe: 4, align: 2, sync: 5 } as const;

function connection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

@Injectable()
export class BullMqJobQueue implements JobQueue, OnModuleDestroy {
  private readonly logger = new Logger(BullMqJobQueue.name);
  private readonly conn: IORedis;
  private readonly queues: Record<QueueName, Queue>;
  private readonly scale: number;
  private readonly prefix: string;

  constructor(private readonly opt: BullOptions) {
    this.conn = connection(opt.redisUrl);
    this.scale = opt.backoffScale ?? 1;
    this.prefix = opt.prefix ?? 'radio_rainy';
    const mk = (name: QueueName): Queue => new Queue(name, { connection: this.conn, prefix: this.prefix });
    this.queues = {
      [QUEUES.TELEGRAM_SYNC]: mk(QUEUES.TELEGRAM_SYNC),
      [QUEUES.LYRICS_FETCH]: mk(QUEUES.LYRICS_FETCH),
      [QUEUES.AUDIO_TRANSCRIPTION]: mk(QUEUES.AUDIO_TRANSCRIPTION),
      [QUEUES.LYRICS_ALIGNMENT]: mk(QUEUES.LYRICS_ALIGNMENT),
    };
  }

  private jobOptions(jobId: string, attempts: number, baseDelayMs: number): JobsOptions {
    return {
      // Deterministic ids dedupe while a job is waiting/active; completed jobs are removed so re-adding works.
      jobId,
      attempts,
      backoff: { type: 'exponential', delay: Math.max(1, Math.round(baseDelayMs * this.scale)) },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600 },
    };
  }

  async enqueueLyricsFetch(p: LyricsJobPayload): Promise<void> {
    await this.queues[QUEUES.LYRICS_FETCH].add('fetch', p, this.jobOptions(`fetch_${p.trackId}`, ATTEMPTS.fetch, 5_000));
  }
  async enqueueTranscription(p: LyricsJobPayload): Promise<void> {
    await this.queues[QUEUES.AUDIO_TRANSCRIPTION].add('transcribe', p, this.jobOptions(`transcribe_${p.trackId}`, ATTEMPTS.transcribe, 30_000));
  }
  async enqueueAlignment(p: LyricsJobPayload & { transcriptId: string }): Promise<void> {
    await this.queues[QUEUES.LYRICS_ALIGNMENT].add('align', p, this.jobOptions(`align_${p.trackId}_${p.transcriptId}`, ATTEMPTS.align, 2_000));
  }
  async enqueueTelegramSync(p: SyncJobPayload): Promise<void> {
    await this.queues[QUEUES.TELEGRAM_SYNC].add('sync', p, this.jobOptions(p.full ? 'sync_full' : 'sync_incremental', ATTEMPTS.sync, 10_000));
  }

  /** Periodic incremental sync, registered idempotently (safe to call on every boot). */
  async schedulePeriodicSync(everySeconds: number): Promise<void> {
    await this.queues[QUEUES.TELEGRAM_SYNC].upsertJobScheduler(
      'telegram-sync-periodic',
      { every: everySeconds * 1000 },
      { name: 'sync', data: {}, opts: { removeOnComplete: true, removeOnFail: { age: 86_400 }, attempts: 1 } },
    );
  }

  async counts(): Promise<Record<QueueName, Record<string, number>>> {
    const out = {} as Record<QueueName, Record<string, number>>;
    for (const name of Object.values(QUEUES)) out[name] = await this.queues[name].getJobCounts('waiting', 'active', 'delayed', 'failed');
    return out;
  }

  createWorkers(handlers: JobHandlers): BullMqWorkers {
    return new BullMqWorkers(this.opt, handlers);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
    await this.conn.quit().catch((e: unknown) => this.logger.warn({ msg: 'redis quit failed', err: String(e) }));
  }
}

export class BullMqWorkers {
  private readonly logger = new Logger(BullMqWorkers.name);
  private readonly conn: IORedis;
  private readonly workers: Worker[] = [];

  constructor(opt: BullOptions, private readonly handlers: JobHandlers) {
    this.conn = connection(opt.redisUrl);
    const prefix = opt.prefix ?? 'radio_rainy';
    const base: Pick<WorkerOptions, 'connection' | 'prefix'> = { connection: this.conn, prefix };

    const ctxOf = (attemptsMade: number, attempts: number | undefined): AttemptContext => ({ isLastAttempt: attemptsMade + 1 >= (attempts ?? 1) });
    const add = (name: QueueName, concurrency: number, fn: (data: never, ctx: AttemptContext, w: Worker) => Promise<void>): void => {
      const w: Worker = new Worker(
        name,
        async (job) => {
          this.logger.log({ msg: 'job started', queue: name, jobId: job.id, attempt: job.attemptsMade + 1 });
          await fn(job.data as never, ctxOf(job.attemptsMade, job.opts.attempts), w);
        },
        { ...base, concurrency },
      );
      w.on('failed', (job, err) =>
        this.logger.warn({ msg: 'job failed', queue: name, jobId: job?.id, attempt: job?.attemptsMade, err: err.message }),
      );
      w.on('error', (err) => this.logger.error({ msg: 'worker error', queue: name, err: err.message }));
      this.workers.push(w);
    };

    add(QUEUES.LYRICS_FETCH, 4, (d: LyricsJobPayload, c) => this.handlers.fetch(d, c));
    // Whisper is CPU/GPU bound: keep concurrency low.
    add(QUEUES.AUDIO_TRANSCRIPTION, 1, (d: LyricsJobPayload, c) => this.handlers.transcribe(d, c));
    add(QUEUES.LYRICS_ALIGNMENT, 4, (d: LyricsJobPayload, c) => this.handlers.align(d, c));
    add(QUEUES.TELEGRAM_SYNC, 1, async (d: SyncJobPayload, _c, w) => {
      try {
        await this.handlers.sync(d);
      } catch (err) {
        if (err instanceof TelegramNotReadyError) {
          this.logger.warn({ msg: 'telegram sync skipped: not logged in / connected' });
          return; // next periodic tick tries again; no retry storm
        }
        if (err instanceof TelegramFloodWaitError) {
          await w.rateLimit((err.retryAfterSeconds + 1) * 1000);
          throw Worker.RateLimitError();
        }
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await this.conn.quit().catch((e: unknown) => this.logger.warn({ msg: 'redis quit failed', err: String(e) }));
  }
}
