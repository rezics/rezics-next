-- Mutable owner projection, separate from immutable derived generations. Each
-- row retains its exact EventTime revision; consumers checkpoint bounded work.
CREATE TABLE access.event_temporal_checkpoint (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    generation uuid NOT NULL,
    data_epoch text NOT NULL,
    relay_sequence numeric NOT NULL DEFAULT 0 CHECK (relay_sequence >= 0),
    backfill_event text,
    backfill_status text CHECK (backfill_status IN ('actual', 'planned')),
    backfill_complete boolean NOT NULL DEFAULT false,
    processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
    actual_revision text NOT NULL DEFAULT 'none',
    planned_revision text NOT NULL DEFAULT 'none'
);
CREATE TABLE access.event_temporal_pending (
    event text NOT NULL,
    time_status text NOT NULL CHECK (time_status IN ('actual', 'planned')),
    source_sequence numeric NOT NULL CHECK (source_sequence >= 0),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    error text,
    PRIMARY KEY (event, time_status)
);
CREATE INDEX event_temporal_retry ON access.event_temporal_pending (retry_at, event, time_status);
CREATE INDEX event_temporal_pending_state ON access.event_temporal_pending (state, retry_at);
CREATE INDEX event_temporal_pending_status_state ON access.event_temporal_pending (time_status, state, event);
CREATE TABLE access.event_temporal_applied (
    event text NOT NULL,
    time_status text NOT NULL CHECK (time_status IN ('actual', 'planned')),
    time_revision text,
    PRIMARY KEY (event, time_status)
);
CREATE INDEX event_temporal_applied_revision ON access.event_temporal_applied (time_revision);
CREATE TABLE access.event_temporal_interval (
    event text NOT NULL CHECK (event ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    time_revision text NOT NULL CHECK (time_revision ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    time_status text NOT NULL CHECK (time_status IN ('actual', 'planned')),
    temporal_kind text NOT NULL CHECK (temporal_kind IN ('instant', 'interval')),
    manifest text NOT NULL CHECK (manifest ~ '^urn:rezics:sha256:[0-9a-f]{64}$'),
    instant_supported boolean NOT NULL,
    start_state text NOT NULL CHECK (start_state IN ('known', 'unknown', 'open')),
    start_precision text CHECK (start_precision IN ('year', 'month', 'day', 'minute', 'second')),
    end_state text NOT NULL CHECK (end_state IN ('known', 'unknown', 'open')),
    end_precision text CHECK (end_precision IN ('year', 'month', 'day', 'minute', 'second')),
    -- Earliest and latest admissible endpoint under the stated precision.
    civil_start_min date,
    civil_start_max date,
    civil_end_min date,
    civil_end_max date,
    instant_start_min timestamptz,
    instant_start_max timestamptz,
    instant_end_min timestamptz,
    instant_end_max timestamptz,
    -- Possible span: any admissible point; definite span: covered by every reading.
    civil_possible daterange GENERATED ALWAYS AS (daterange(civil_start_min, civil_end_max, '[]')) STORED,
    civil_definite daterange GENERATED ALWAYS AS (
      CASE WHEN civil_start_max <= civil_end_min
        THEN daterange(civil_start_max, civil_end_min, '[]')
        ELSE 'empty'::daterange END) STORED,
    instant_possible tstzrange GENERATED ALWAYS AS (
      CASE WHEN instant_supported THEN tstzrange(instant_start_min, instant_end_max, '[]') END) STORED,
    instant_definite tstzrange GENERATED ALWAYS AS (
      CASE WHEN instant_supported AND instant_start_max <= instant_end_min
        THEN tstzrange(instant_start_max, instant_end_min, '[]')
        WHEN instant_supported THEN 'empty'::tstzrange END) STORED,
    PRIMARY KEY (event, time_status),
    CONSTRAINT event_temporal_instant_shape CHECK (temporal_kind = 'interval' OR (
      start_state = 'known' AND end_state = 'known' AND end_precision = start_precision
      AND civil_end_min IS NOT DISTINCT FROM civil_start_min
      AND civil_end_max IS NOT DISTINCT FROM civil_start_max
      AND instant_end_min IS NOT DISTINCT FROM instant_start_min
      AND instant_end_max IS NOT DISTINCT FROM instant_start_max)),
    CONSTRAINT event_temporal_civil_bounds CHECK ((
      ((start_state = 'known') = (start_precision IS NOT NULL))
      AND ((start_state = 'known') = (civil_start_min IS NOT NULL AND civil_start_max IS NOT NULL))
      AND (start_state = 'known' OR num_nonnulls(civil_start_min, civil_start_max) = 0)
      AND ((end_state = 'known') = (end_precision IS NOT NULL))
      AND ((end_state = 'known') = (civil_end_min IS NOT NULL AND civil_end_max IS NOT NULL))
      AND (end_state = 'known' OR num_nonnulls(civil_end_min, civil_end_max) = 0)
      AND civil_start_min <= civil_start_max AND civil_end_min <= civil_end_max
      AND civil_start_min <= civil_end_max)),
    CONSTRAINT event_temporal_instant_bounds CHECK (NOT instant_supported OR (
      ((start_state = 'known') = (start_precision IS NOT NULL))
      AND ((start_state = 'known') = (instant_start_min IS NOT NULL AND instant_start_max IS NOT NULL))
      AND (start_state = 'known' OR num_nonnulls(instant_start_min, instant_start_max) = 0)
      AND ((end_state = 'known') = (end_precision IS NOT NULL))
      AND ((end_state = 'known') = (instant_end_min IS NOT NULL AND instant_end_max IS NOT NULL))
      AND (end_state = 'known' OR num_nonnulls(instant_end_min, instant_end_max) = 0)
      AND instant_start_min <= instant_start_max AND instant_end_min <= instant_end_max
      AND instant_start_min <= instant_end_max))
);

CREATE INDEX event_temporal_civil_possible ON access.event_temporal_interval USING gist (civil_possible);
CREATE INDEX event_temporal_revision ON access.event_temporal_interval (time_revision);
CREATE INDEX event_temporal_civil_definite ON access.event_temporal_interval USING gist (civil_definite);
CREATE INDEX event_temporal_instant_possible ON access.event_temporal_interval USING gist (instant_possible) WHERE instant_supported;
CREATE INDEX event_temporal_instant_definite ON access.event_temporal_interval USING gist (instant_definite) WHERE instant_supported;
CREATE TABLE access.event_temporal_window (
    id uuid PRIMARY KEY,
    scope_key text NOT NULL UNIQUE,
    interpretation text NOT NULL CHECK (interpretation IN ('civil-date', 'instant')),
    grain text NOT NULL CHECK (grain IN ('year', 'month', 'day')),
    bucket_start date NOT NULL,
    bucket_end date NOT NULL CHECK (bucket_end >= bucket_start),
    query_start text NOT NULL,
    query_end text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'building', 'ready')),
    after_event text,
    after_status text CHECK (after_status IN ('actual', 'planned')),
    processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
    revision numeric NOT NULL DEFAULT 1 CHECK (revision > 0),
    unsupported_actual_count bigint NOT NULL DEFAULT 0 CHECK (unsupported_actual_count >= 0),
    unsupported_planned_count bigint NOT NULL DEFAULT 0 CHECK (unsupported_planned_count >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX event_temporal_window_work ON access.event_temporal_window (state, id);
CREATE INDEX event_temporal_window_build ON access.event_temporal_window (created_at, id)
    WHERE state IN ('queued', 'building');
CREATE TABLE access.event_temporal_member (
    window_id uuid NOT NULL REFERENCES access.event_temporal_window(id) ON DELETE CASCADE,
    event text NOT NULL,
    time_status text NOT NULL CHECK (time_status IN ('actual', 'planned')),
    time_revision text NOT NULL,
    definite boolean NOT NULL,
    PRIMARY KEY (window_id, event, time_status)
);
CREATE INDEX event_temporal_member_definite ON access.event_temporal_member (window_id, event, time_status) WHERE definite;
-- A sparse status selection seeks directly into that status instead of
-- filtering an arbitrarily large population in the other status.
CREATE INDEX event_temporal_member_status ON access.event_temporal_member (window_id, time_status, event);
CREATE INDEX event_temporal_member_status_definite ON access.event_temporal_member (window_id, time_status, event) WHERE definite;
CREATE TABLE access.event_temporal_bucket (
    window_id uuid NOT NULL REFERENCES access.event_temporal_window(id) ON DELETE CASCADE,
    time_status text NOT NULL CHECK (time_status IN ('actual', 'planned')),
    bucket_start date NOT NULL,
    definite_count bigint NOT NULL CHECK (definite_count >= 0),
    possible_count bigint NOT NULL CHECK (possible_count >= definite_count),
    PRIMARY KEY (window_id, time_status, bucket_start)
);
CREATE TABLE access.event_temporal_window_update (
    id bigserial PRIMARY KEY,
    event text NOT NULL,
    time_status text NOT NULL CHECK (time_status IN ('actual', 'planned')),
    old_interval jsonb,
    new_interval jsonb,
    after_window uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX event_temporal_window_update_status ON access.event_temporal_window_update (time_status, event);
CREATE INDEX event_temporal_window_update_event ON access.event_temporal_window_update (event, time_status);
