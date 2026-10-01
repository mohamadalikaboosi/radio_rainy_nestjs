/** Read-side data the language-learning loop needs (kept out of the use case so it stays free of SQL). */
export interface RetrainCandidate {
  trackId: string;
  transcriptId: string;
  /** Latest synced-lyrics version, null when there is none yet. */
  version: number | null;
}

export interface TrainingRow {
  id: string;
  lang: string | null;
  raw: string;
  segments: unknown;
  lines: unknown;
}

export abstract class LanguageData {
  abstract tracksByLanguage(): Promise<{ language: string | null; tracks: number }[]>;
  /** Number of tracks that have at least one transcript. */
  abstract transcribedTrackCount(): Promise<number>;
  abstract retrainCandidates(limit: number, offset: number): Promise<RetrainCandidate[]>;
  /** Fine-tuning set: tracks with lyrics and aligned lines, keyset-paginated by track id. */
  abstract trainingBatch(afterTrackId: string, limit: number): Promise<TrainingRow[]>;
}
