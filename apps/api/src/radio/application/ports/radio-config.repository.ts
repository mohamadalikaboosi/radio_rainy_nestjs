import { TxHandle } from '../../../shared/kernel/transaction';
import { RadioConfigSnapshot, TrackCandidate } from '../../domain/radio.types';

export interface RadioConfigWithMeta {
  snapshot: RadioConfigSnapshot;
  enabled: boolean;
  version: number;
}

export abstract class RadioConfigRepository {
  abstract getSnapshot(channelId: string, q?: TxHandle): Promise<RadioConfigWithMeta>;
  /** Eligibility base set: enabled + audio READY + still on Telegram. Hashtag matching is the engine's job. */
  abstract loadCandidates(channelId: string, q?: TxHandle): Promise<TrackCandidate[]>;
  /** Applies the env default only while nobody has configured the radio yet. */
  abstract applyDefaultWindow(channelId: string, window: number): Promise<void>;
}
