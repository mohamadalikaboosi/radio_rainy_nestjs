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
  {
    id: '003_multichannel_settings_language',
    sql: `
-- Settings managed from the admin panel. Secrets are AES-256-GCM ciphertext, never plaintext.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  plain JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per Telegram channel = one radio station.
CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_channel_id BIGINT NOT NULL UNIQUE,
  reference TEXT NOT NULL,
  title TEXT NOT NULL,
  username TEXT,
  slug TEXT NOT NULL UNIQUE,
  started BOOLEAN NOT NULL DEFAULT FALSE,
  telegram_live_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  live_status TEXT NOT NULL DEFAULT 'OFF' ${enumCheck('live_status', ['OFF', 'STARTING', 'LIVE', 'ERROR'])},
  live_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Radio configuration/state become per channel (config rows are recreated: pre-multichannel installs had none worth keeping).
DROP TABLE radio_rule_hashtags, radio_rules, radio_hashtag_selection, radio_configuration, radio_state;

CREATE TABLE radio_configuration (
  channel_id BIGINT PRIMARY KEY REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
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
  channel_id BIGINT NOT NULL REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, hashtag_id)
);
CREATE TABLE radio_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id BIGINT NOT NULL REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL,
  match_mode TEXT NOT NULL DEFAULT 'ANY' ${enumCheck('match_mode', ['ANY', 'ALL'])},
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX radio_rules_channel_priority_idx ON radio_rules (channel_id, priority);
CREATE TABLE radio_rule_hashtags (
  rule_id UUID NOT NULL REFERENCES radio_rules(id) ON DELETE CASCADE,
  hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  kind TEXT NOT NULL ${enumCheck('kind', ['INCLUDE', 'EXCLUDE'])},
  PRIMARY KEY (rule_id, hashtag_id, kind)
);
CREATE TABLE radio_state (
  channel_id BIGINT PRIMARY KEY REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'STOPPED' ${enumCheck('status', ['PLAYING', 'STOPPED', 'IDLE', 'ERROR'])},
  status_reason TEXT,
  current_track_id UUID REFERENCES tracks(id) ON DELETE SET NULL,
  current_history_id UUID,
  started_at TIMESTAMPTZ,
  next_track_id UUID REFERENCES tracks(id) ON DELETE SET NULL,
  rotation_cursor INTEGER NOT NULL DEFAULT 0,
  transition_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tracks ADD COLUMN lyrics_language TEXT;
CREATE INDEX tracks_channel_idx ON tracks (telegram_channel_id);

-- Learned Persian/English ASR-spelling corrections (what Whisper wrote -> what the lyrics say), trained from aligned songs.
CREATE TABLE lexicon_entries (
  lang TEXT NOT NULL,
  asr_word TEXT NOT NULL,
  lyric_word TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'LEARNED' ${enumCheck('status', ['LEARNED', 'APPROVED', 'REJECTED'])},
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lang, asr_word, lyric_word)
);
CREATE INDEX lexicon_lang_idx ON lexicon_entries (lang, status);
`,
  },
  {
    id: '004_listener_samples',
    sql: `
-- Listener count of each running station, sampled by the leader (basis of the audience report).
CREATE TABLE listener_samples (
  channel_id BIGINT NOT NULL REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL,
  listeners INTEGER NOT NULL CHECK (listeners >= 0),
  PRIMARY KEY (channel_id, at)
);
CREATE INDEX listener_samples_at_idx ON listener_samples (at DESC);
CREATE INDEX playback_history_ended_idx ON playback_history (end_reason, started_at DESC);
`,
  },
  {
    id: '005_engagement',
    sql: `
-- Ad currently on air (the public API reports it instead of a track).
ALTER TABLE radio_state ADD COLUMN ad_id UUID, ADD COLUMN ad_started_at TIMESTAMPTZ;

-- Manual Telegram live target (the "Server URL" + "Stream key" of Telegram's "Stream with..." screen). The key is stored encrypted.
ALTER TABLE channels ADD COLUMN live_rtmp_url TEXT, ADD COLUMN live_rtmp_key_enc TEXT, ADD COLUMN live_target_rev INTEGER NOT NULL DEFAULT 0;

-- Audio ads, played between tracks. channel_id NULL = every station. Audio/image live in the row (bounded, admin-uploaded).
CREATE TABLE ads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id BIGINT REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  link_url TEXT,
  cta_label TEXT,
  audio BYTEA,
  audio_mime TEXT,
  audio_size INTEGER,
  bytes_per_sec INTEGER,
  duration_seconds DOUBLE PRECISION,
  image BYTEA,
  image_mime TEXT,
  plays INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ads_channel_idx ON ads (channel_id);

-- Sponsors: a banner with a call-to-action link shown in the player.
CREATE TABLE sponsors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id BIGINT REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tagline TEXT,
  url TEXT NOT NULL,
  cta_label TEXT NOT NULL DEFAULT 'Visit',
  logo BYTEA,
  logo_mime TEXT,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sponsors_channel_idx ON sponsors (channel_id);

-- Per-station engagement settings: ad frequency and the periodic "which tag shall we play?" vote.
CREATE TABLE channel_engagement (
  channel_id BIGINT PRIMARY KEY REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  ads_every_n_tracks INTEGER NOT NULL DEFAULT 0 CHECK (ads_every_n_tracks BETWEEN 0 AND 100),
  tag_vote_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  tag_vote_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (tag_vote_interval_minutes BETWEEN 1 AND 1440),
  tag_vote_poll_minutes INTEGER NOT NULL DEFAULT 3 CHECK (tag_vote_poll_minutes BETWEEN 1 AND 60),
  tag_vote_play_minutes INTEGER NOT NULL DEFAULT 20 CHECK (tag_vote_play_minutes BETWEEN 1 AND 240),
  tag_vote_options INTEGER NOT NULL DEFAULT 3 CHECK (tag_vote_options BETWEEN 2 AND 6),
  tag_vote_allowlist TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tag_polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id BIGINT NOT NULL REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  options TEXT[] NOT NULL,
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' ${enumCheck('status', ['OPEN', 'CLOSED'])},
  winner TEXT,
  play_until TIMESTAMPTZ,
  finished BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX tag_polls_channel_idx ON tag_polls (channel_id, opens_at DESC);
CREATE TABLE tag_votes (
  poll_id UUID NOT NULL REFERENCES tag_polls(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  hashtag TEXT NOT NULL,
  voted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, voter_id)
);
CREATE INDEX tag_votes_ip_idx ON tag_votes (poll_id, ip_hash);
`,
  },
  {
    id: '006_accounts_campaigns_billing',
    sql: `
-- Customer accounts (advertisers and station owners). The platform operator stays the env-configured Super Admin.
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' ${enumCheck('status', ['ACTIVE', 'SUSPENDED'])},
  credit_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE account_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX account_users_email_idx ON account_users (lower(email));

-- Platform switches: billing is OFF (everything free) until the operator turns it on.
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Money ledger (amounts in the smallest currency unit). Only written when billing is enabled or an admin adjusts credit.
CREATE TABLE credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  kind TEXT NOT NULL ${enumCheck('kind', ['TOPUP', 'PLAY', 'CLICK', 'ADJUST'])},
  ref_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_account_idx ON credit_ledger (account_id, id DESC);

-- Stations owned by a customer; ads become campaigns (owner, review state, schedule, play cap).
ALTER TABLE channels ADD COLUMN owner_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX channels_owner_idx ON channels (owner_account_id);
ALTER TABLE ads
  ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'APPROVED' ${enumCheck('status', ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED'])},
  ADD COLUMN review_note TEXT,
  ADD COLUMN starts_at TIMESTAMPTZ,
  ADD COLUMN ends_at TIMESTAMPTZ,
  ADD COLUMN max_plays INTEGER CHECK (max_plays IS NULL OR max_plays > 0),
  ADD COLUMN submitted_at TIMESTAMPTZ;
CREATE INDEX ads_account_idx ON ads (account_id);
CREATE INDEX ads_status_idx ON ads (status);
`,
  },
  {
    id: '007_live_messages',
    sql: `
-- Announcements pushed to the listeners of a station (WebSocket) while they are active.
CREATE TABLE live_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id BIGINT NOT NULL REFERENCES channels(telegram_channel_id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  level TEXT NOT NULL DEFAULT 'INFO' ${enumCheck('level', ['INFO', 'WARN'])},
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX live_messages_active_idx ON live_messages (channel_id, expires_at);

-- How the public player receives the audio of a station: plain HTTP MP3 (default) or binary WebSocket frames (MSE).
ALTER TABLE channel_engagement ADD COLUMN audio_transport TEXT NOT NULL DEFAULT 'HTTP' ${enumCheck('audio_transport', ['HTTP', 'WEBSOCKET'])};
`,
  },
  {
    id: '008_admin_users',
    sql: `
-- Super admin accounts live in the database (seeded on first start); the env credentials are only an optional bootstrap.
CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  password_changed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX admin_users_username_idx ON admin_users (lower(username));
`,
  },
  {
    id: '009_channel_public_id',
    sql: `
-- A permanent public address of a station (localhost/<public_id>). Created with the station, never changes: it is what the station's own page is locked to.
ALTER TABLE channels ADD COLUMN public_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX channels_public_id_idx ON channels (public_id);
CREATE FUNCTION channels_public_id_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION 'channels.public_id is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER channels_public_id_immutable BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION channels_public_id_immutable();
`,
  },
];
