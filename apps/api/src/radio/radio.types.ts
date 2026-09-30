export const RADIO_MODES = ['GLOBAL_RANDOM', 'HASHTAG_RANDOM', 'HASHTAG_ROTATION', 'CUSTOM_RULE'] as const;
export type RadioMode = (typeof RADIO_MODES)[number];
export type HashtagMatchMode = 'ANY' | 'ALL';
export type RadioStatus = 'PLAYING' | 'STOPPED' | 'IDLE' | 'ERROR';

/** A playable track (already filtered: enabled, audio READY, not deleted) with normalized hashtags. */
export interface TrackCandidate {
  id: string;
  hashtags: readonly string[];
}

export interface HashtagSelection {
  /** normalized hashtag value */
  hashtag: string;
  weight: number;
}

export interface RadioRuleSnapshot {
  id: string;
  name: string;
  priority: number;
  matchMode: HashtagMatchMode;
  weight: number;
  enabled: boolean;
  include: readonly string[];
  exclude: readonly string[];
}

export interface RadioConfigSnapshot {
  mode: RadioMode;
  hashtagMatchMode: HashtagMatchMode;
  recentTrackWindow: number;
  /** ordered: order matters for HASHTAG_ROTATION */
  hashtags: readonly HashtagSelection[];
  rules: readonly RadioRuleSnapshot[];
  /** if a mode yields no eligible tracks, fall back to global random */
  fallbackToGlobal: boolean;
}

export interface SelectionInput {
  config: RadioConfigSnapshot;
  candidates: readonly TrackCandidate[];
  /** most recent first; the currently playing track should be first */
  recentTrackIds: readonly string[];
  rotationCursor: number;
}

export interface SelectionResult {
  trackId: string | null;
  reason: string;
  /** size of the eligible set before recent-track exclusion */
  eligibleCount: number;
  matchedRuleId?: string;
  matchedHashtag?: string;
  nextCursor: number;
}

export interface PreviewResult {
  eligibleCount: number;
  trackIds: string[];
  steps: SelectionResult[];
}
