import { Injectable, Logger } from '@nestjs/common';
import { PlaybackHistoryRepository } from './ports/playback-history.repository';
import { RadioConfigRepository } from './ports/radio-config.repository';
import { RadioRuleEngine } from '../domain/radio-rule-engine';
import { RadioStateRepository } from './ports/radio-state.repository';
import { SelectionResult } from '../domain/radio.types';
import { Rng, cryptoRng } from '../domain/rng';

export interface NextSelection {
  trackId: string | null;
  reason: string;
  configVersion: number;
  result: SelectionResult | null;
}

/** Something that can temporarily force one hashtag (e.g. the listeners' vote winner). */
export interface TagOverride {
  activeTag(channelId: string): Promise<string | null>;
}

/** Loads config + candidates + history and asks the (pure) RadioRuleEngine. Contains no selection logic itself. */
@Injectable()
export class RadioScheduler {
  private readonly logger = new Logger(RadioScheduler.name);

  constructor(
    private readonly config: RadioConfigRepository,
    private readonly history: PlaybackHistoryRepository,
    private readonly state: RadioStateRepository,
    private readonly engine: RadioRuleEngine = new RadioRuleEngine(),
    private readonly rng: Rng = cryptoRng,
    private readonly override?: TagOverride,
  ) {}

  /** `exclude`: tracks that must not be chosen now (e.g. a pre-fetched track that turned out broken). */
  async selectNext(channelId: string, exclude: readonly string[] = []): Promise<NextSelection> {
    const cfg = await this.config.getSnapshot(channelId);
    if (!cfg.enabled) return { trackId: null, reason: 'RADIO_DISABLED', configVersion: cfg.version, result: null };

    const [allCandidates, st] = await Promise.all([this.config.loadCandidates(channelId), this.state.get(channelId)]);
    const candidates = exclude.length > 0 ? allCandidates.filter((c) => !exclude.includes(c.id)) : allCandidates;
    if (candidates.length === 0) return { trackId: null, reason: 'NO_PLAYABLE_TRACKS', configVersion: cfg.version, result: null };

    // Current track first, so "never immediately repeat" holds even with window = 0 semantics of history.
    const window = cfg.snapshot.recentTrackWindow;
    const recent = await this.history.recentTrackIds(channelId, Math.max(window, 1));
    const recentIds = st.currentTrackId ? [st.currentTrackId, ...recent.filter((id) => id !== st.currentTrackId)] : recent;

    const forced = (await this.override?.activeTag(channelId)) ?? null;
    const config = forced
      ? { ...cfg.snapshot, mode: 'HASHTAG_RANDOM' as const, hashtagMatchMode: 'ANY' as const, hashtags: [{ hashtag: forced, weight: 1 }], fallbackToGlobal: true }
      : cfg.snapshot;
    const result = this.engine.select(
      { config, candidates, recentTrackIds: window === 0 ? recentIds.slice(0, 1) : recentIds, rotationCursor: st.rotationCursor },
      this.rng,
    );
    if (result.nextCursor !== st.rotationCursor) await this.state.setRotationCursor(channelId, result.nextCursor);
    this.logger.log({ msg: 'track selected', channelId, trackId: result.trackId, reason: result.reason, eligible: result.eligibleCount, ruleId: result.matchedRuleId, hashtag: result.matchedHashtag, configVersion: cfg.version });
    return { trackId: result.trackId, reason: result.reason, configVersion: cfg.version, result };
  }
}
