import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DatabaseService } from '../src/database/database.service';
import { LyricsRepository } from '../src/lyrics/lyrics.repository';
import { PlaybackEngine } from '../src/playback/playback-engine';
import { CurrentRadioService } from '../src/radio/current-radio.service';
import { Broadcaster } from '../src/streaming/broadcaster';
import { RadioController, STREAM_OPTIONS } from '../src/streaming/radio.controller';
import { Harness } from './engine-harness';

export async function createRadioApp(db: DatabaseService, h: Harness): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    controllers: [RadioController],
    providers: [
      { provide: Broadcaster, useValue: h.broadcaster },
      { provide: PlaybackEngine, useValue: h.engine },
      { provide: CurrentRadioService, useValue: new CurrentRadioService(h.state, h.tracks, new LyricsRepository(db)) },
      { provide: STREAM_OPTIONS, useValue: { maxBacklogBytes: 256 * 1024, stationName: 'test' } },
    ],
  }).compile();
  const app = mod.createNestApplication();
  await app.listen(0);
  return app;
}
