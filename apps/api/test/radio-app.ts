import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChannelRepository } from '../src/channels/channel.repository';
import { DatabaseService } from '../src/database/database.service';
import { LyricsRepository } from '../src/lyrics/lyrics.repository';
import { StationManager } from '../src/playback/station-manager';
import { CurrentRadioService } from '../src/radio/current-radio.service';
import { RadioController, STREAM_OPTIONS } from '../src/streaming/radio.controller';
import { Harness } from './engine-harness';

/** Public radio API on top of a harness engine; the station registry is a stand-in that maps the channel to the harness. */
export async function createRadioApp(db: DatabaseService, h: Harness): Promise<INestApplication> {
  const stations = { get: (id: string) => (id === h.channelId ? { engine: h.engine, broadcaster: h.broadcaster } : undefined) } as unknown as StationManager;
  const mod = await Test.createTestingModule({
    controllers: [RadioController],
    providers: [
      { provide: StationManager, useValue: stations },
      { provide: ChannelRepository, useValue: new ChannelRepository(db) },
      { provide: CurrentRadioService, useValue: new CurrentRadioService(h.state, h.tracks, new LyricsRepository(db)) },
      { provide: STREAM_OPTIONS, useValue: { maxBacklogBytes: 256 * 1024, stationName: 'test' } },
    ],
  }).compile();
  const app = mod.createNestApplication();
  await app.listen(0);
  return app;
}
