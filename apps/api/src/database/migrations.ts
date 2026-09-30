export interface Migration {
  id: string;
  sql: string;
}

const enumCheck = (col: string, values: readonly string[]): string => `CHECK (${col} IN (${values.map((v) => `'${v}'`).join(', ')}))`;

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_channel_id BIGINT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  duration INTEGER,
  mime_type TEXT,
  file_size BIGINT,
  telegram_file_reference TEXT NOT NULL,
  telegram_post_url TEXT,
  lyrics_url TEXT,
  caption_raw TEXT,
  status TEXT NOT NULL DEFAULT 'READY' ${enumCheck('status', ['READY', 'FAILED', 'UNAVAILABLE'])},
  lyrics_status TEXT NOT NULL DEFAULT 'LYRICS_NONE' ${enumCheck('lyrics_status', ['LYRICS_NONE', 'LYRICS_PENDING', 'LYRICS_PROCESSING', 'LYRICS_READY', 'LYRICS_FAILED'])},
  lyrics_error TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  play_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracks_channel_message_uq UNIQUE (telegram_channel_id, telegram_message_id)
);
CREATE INDEX tracks_playable_idx ON tracks (id) WHERE status = 'READY' AND enabled AND deleted_at IS NULL;
CREATE INDEX tracks_lyrics_status_idx ON tracks (lyrics_status);
CREATE INDEX tracks_last_played_idx ON tracks (last_played_at DESC NULLS LAST);
CREATE INDEX tracks_artist_idx ON tracks (lower(artist));
CREATE INDEX tracks_album_idx ON tracks (lower(album));
CREATE INDEX tracks_search_trgm_idx ON tracks USING gin ((coalesce(title,'') || ' ' || coalesce(artist,'') || ' ' || coalesce(album,'')) gin_trgm_ops);

CREATE TABLE lyrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL UNIQUE REFERENCES tracks(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  raw_text TEXT,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' ${enumCheck('status', ['PENDING', 'FETCHED', 'FAILED'])},
  error TEXT,
  fetched_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lyrics_source_url_idx ON lyrics (source_url);

CREATE TABLE transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  language TEXT,
  audio_hash TEXT NOT NULL,
  segments JSONB NOT NULL,
  words JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transcripts_uq UNIQUE (track_id, audio_hash, provider, model)
);

CREATE TABLE synced_lyrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  lines JSONB NOT NULL,
  quality REAL NOT NULL,
  algorithm_version TEXT NOT NULL,
  transcript_id UUID REFERENCES transcripts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT synced_lyrics_track_version_uq UNIQUE (track_id, version)
);

CREATE TABLE playback_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT ${enumCheck('end_reason', ['FINISHED', 'SKIPPED', 'ERROR', 'ADMIN', 'SHUTDOWN'])}
);
CREATE INDEX playback_history_started_idx ON playback_history (started_at DESC);
CREATE INDEX playback_history_track_idx ON playback_history (track_id, started_at DESC);

CREATE TABLE sync_state (
  channel_id BIGINT PRIMARY KEY,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  last_full_sync_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hashtags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE track_hashtags (
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (track_id, hashtag_id)
);
CREATE INDEX track_hashtags_hashtag_idx ON track_hashtags (hashtag_id);

CREATE TABLE radio_configuration (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'GLOBAL_RANDOM' ${enumCheck('mode', ['GLOBAL_RANDOM', 'HASHTAG_RANDOM', 'HASHTAG_ROTATION', 'CUSTOM_RULE'])},
  hashtag_match_mode TEXT NOT NULL DEFAULT 'ANY' ${enumCheck('hashtag_match_mode', ['ANY', 'ALL'])},
  recent_track_window INTEGER NOT NULL DEFAULT 10 CHECK (recent_track_window >= 0),
  fallback_to_global BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE radio_hashtag_selection (
  hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hashtag_id)
);
CREATE TABLE radio_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  priority INTEGER NOT NULL,
  match_mode TEXT NOT NULL DEFAULT 'ANY' ${enumCheck('match_mode', ['ANY', 'ALL'])},
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX radio_rules_priority_idx ON radio_rules (priority);
CREATE TABLE radio_rule_hashtags (
  rule_id UUID NOT NULL REFERENCES radio_rules(id) ON DELETE CASCADE,
  hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  kind TEXT NOT NULL ${enumCheck('kind', ['INCLUDE', 'EXCLUDE'])},
  PRIMARY KEY (rule_id, hashtag_id, kind)
);

CREATE TABLE radio_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'IDLE' ${enumCheck('status', ['PLAYING', 'STOPPED', 'IDLE', 'ERROR'])},
  status_reason TEXT,
  current_track_id UUID REFERENCES tracks(id) ON DELETE SET NULL,
  current_history_id UUID,
  started_at TIMESTAMPTZ,
  next_track_id UUID REFERENCES tracks(id) ON DELETE SET NULL,
  rotation_cursor INTEGER NOT NULL DEFAULT 0,
  configuration_version INTEGER NOT NULL DEFAULT 1,
  transition_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hashtag_stats (
  hashtag_id UUID PRIMARY KEY REFERENCES hashtags(id) ON DELETE CASCADE,
  track_count INTEGER NOT NULL DEFAULT 0,
  playable_count INTEGER NOT NULL DEFAULT 0,
  failed_lyrics_count INTEGER NOT NULL DEFAULT 0,
  plays BIGINT NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before JSONB,
  after JSONB,
  request_id TEXT
);
CREATE INDEX audit_logs_at_idx ON audit_logs (at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

INSERT INTO radio_configuration (id) VALUES (1);
INSERT INTO radio_state (id) VALUES (1);
`,
  },
  {
    id: '002_telegram_session',
    sql: `
CREATE TABLE telegram_session (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ciphertext TEXT NOT NULL,           -- AES-256-GCM envelope, never plaintext
  account_label TEXT,                 -- masked display info only (e.g. +98******12)
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];
