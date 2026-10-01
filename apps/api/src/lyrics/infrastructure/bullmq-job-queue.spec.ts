import { randomUUID } from 'node:crypto';
import { TEST_REDIS_URL } from '../../../test/test-db';
import { BullMqJobQueue, BullMqWorkers, JobHandlers } from './bullmq-job-queue';
import { AttemptContext, LyricsJobPayload } from '../application/ports/job-queues';

const wait = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('BullMqJobQueue (real Redis)', () => {
  let queue: BullMqJobQueue;
  let workers: BullMqWorkers | undefined;
  const fetchCalls: { p: LyricsJobPayload; ctx: AttemptContext }[] = [];
  const handlers = (over: Partial<JobHandlers> = {}): JobHandlers => ({
    fetch: async (p, ctx) => void fetchCalls.push({ p, ctx }),
    transcribe: async () => undefined,
    align: async () => undefined,
    sync: async () => undefined,
    ...over,
  });

  beforeEach(() => {
    fetchCalls.length = 0;
    queue = new BullMqJobQueue({ redisUrl: TEST_REDIS_URL, prefix: `rr-test-${randomUUID()}`, backoffScale: 0.001 });
  });
  afterEach(async () => {
    await workers?.close();
    workers = undefined;
    await queue.onModuleDestroy();
  });

  it('runs a job and reports attempt context', async () => {
    workers = queue.createWorkers(handlers());
    await queue.enqueueLyricsFetch({ trackId: 't1' });
    await wait(() => fetchCalls.length === 1);
    expect(fetchCalls[0]?.ctx.isLastAttempt).toBe(false);
  });

  it('retries failures with backoff and flags the last attempt', async () => {
    workers = queue.createWorkers(
      handlers({
        fetch: async (p, ctx) => {
          fetchCalls.push({ p, ctx });
          throw new Error('boom');
        },
      }),
    );
    await queue.enqueueLyricsFetch({ trackId: 't1' });
    await wait(() => fetchCalls.length === 5);
    expect(fetchCalls.map((c) => c.ctx.isLastAttempt)).toEqual([false, false, false, false, true]);
  });

  it('dedupes identical pending jobs by deterministic id', async () => {
    await queue.enqueueLyricsFetch({ trackId: 't1' });
    await queue.enqueueLyricsFetch({ trackId: 't1' });
    await queue.enqueueLyricsFetch({ trackId: 't2' });
    expect((await queue.counts())['lyrics-fetch']?.waiting).toBe(2);
  });

  it('a completed job can be enqueued again (reprocess)', async () => {
    workers = queue.createWorkers(handlers());
    await queue.enqueueLyricsFetch({ trackId: 't1' });
    await wait(() => fetchCalls.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    await queue.enqueueLyricsFetch({ trackId: 't1', force: true });
    await wait(() => fetchCalls.length === 2);
    expect(fetchCalls[1]?.p.force).toBe(true);
  });

  it('telegram sync tolerates "not logged in" without retry storm', async () => {
    let calls = 0;
    const { TelegramNotReadyError } = await import('../../catalog/application/ports/telegram.types');
    workers = queue.createWorkers(
      handlers({
        sync: async () => {
          calls++;
          throw new TelegramNotReadyError();
        },
      }),
    );
    await queue.enqueueTelegramSync({});
    await wait(() => calls >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(1);
  });
});
