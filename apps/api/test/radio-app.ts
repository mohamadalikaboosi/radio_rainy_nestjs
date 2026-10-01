import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChannelRepository } from '../src/catalog/application/ports/channel.repository';
import { PgChannelRepository } from '../src/catalog/infrastructure/persistence/channel.repository';
import { DatabaseService } from '../src/shared/infrastructure/database/database.service';
import { PgLyricsRepository } from '../src/lyrics/infrastructure/lyrics.repository';
import { StationManager } from '../src/radio/application/station-manager';
import { CurrentRadioService } from '../src/radio/application/current-radio.service';
import { RadioController, STREAM_OPTIONS } from '../src/radio/interface/radio.controller';
import { LowQualityStream } from '../src/radio/application/ports/low-quality-stream';
import { Harness } from './engine-harness';

/** Public radio API on top of a harness engine; the station registry is a stand-in that maps the channel to the harness. */
export async function createRadioApp(db: DatabaseService, h: Harness, low?: LowQualityStream): Promise<INestApplication> {
  const stations = { get: (id: string) => (id === h.channelId ? { engine: h.engine, broadcaster: h.broadcaster, low } : undefined) } as unknown as StationManager;
  const mod = await Test.createTestingModule({
    controllers: [RadioController],
    providers: [
      { provide: StationManager, useValue: stations },
      { provide: ChannelRepository, useValue: new PgChannelRepository(db) },
      { provide: CurrentRadioService, useValue: new CurrentRadioService(h.state, h.tracks, new PgLyricsRepository(db)) },
      { provide: STREAM_OPTIONS, useValue: { maxBacklogBytes: 256 * 1024, stationName: 'test' } },
    ],
  }).compile();
  const app = mod.createNestApplication();
  await app.listen(0);
  return app;
}
