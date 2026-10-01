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

  // ---- writes: every method takes the open transaction of the use case (the service owns the transaction boundary) ----

  /** Row lock on the singleton config (concurrent admin writes queue up). Returns the current version, or null when the channel has no configuration. */
  abstract lock(tx: TxHandle, channelId: string): Promise<number | null>;
  /** normalized hashtag -> id for the known ones (unknown tags are simply absent). */
  abstract hashtagIds(tx: TxHandle, tags: readonly string[]): Promise<Map<string, string>>;
  abstract updateSettings(tx: TxHandle, channelId: string, s: { mode: string; hashtagMatchMode: string; recentTrackWindow: number; fallbackToGlobal: boolean; enabled: boolean }, actor: string): Promise<void>;
  abstract replaceHashtagSelection(tx: TxHandle, channelId: string, entries: readonly { hashtagId: string; weight: number }[]): Promise<void>;
  abstract bumpVersion(tx: TxHandle, channelId: string, actor: string): Promise<void>;
  abstract insertRule(tx: TxHandle, channelId: string, r: { name: string; priority: number; matchMode: string; weight: number; enabled: boolean }): Promise<string>;
  abstract updateRule(tx: TxHandle, channelId: string, ruleId: string, r: { name: string; priority: number; matchMode: string; weight: number; enabled: boolean }): Promise<void>;
  abstract replaceRuleHashtags(tx: TxHandle, ruleId: string, tags: readonly { hashtagId: string; kind: 'INCLUDE' | 'EXCLUDE' }[]): Promise<void>;
  abstract deleteRule(tx: TxHandle, channelId: string, ruleId: string): Promise<void>;
}
