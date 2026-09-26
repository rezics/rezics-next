-- Derived event interval keys and histogram buckets of one event-interval
-- generation. Jena Event time revisions remain the exact value and lexical
-- owner. Each key names its exact source revision, interpretation, conversion
-- profile and precision; unknown or open endpoints stay explicit states and
-- become unbounded only inside the derived possible range, never a stored date.
CREATE TABLE access.event_interval_key (
    generation_id uuid NOT NULL,
    family text NOT NULL DEFAULT 'event-interval' CHECK (family = 'event-interval'),
    event text NOT NULL CHECK (event ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    time_revision text NOT NULL CHECK (time_revision ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    time_status text NOT NULL CHECK (time_status IN ('actual', 'planned')),
    temporal_kind text NOT NULL CHECK (temporal_kind IN ('instant', 'interval')),
    interpretation text NOT NULL CHECK (interpretation IN ('civil-date', 'instant')),
    conversion_profile text NOT NULL
        CHECK (conversion_profile ~ '^https://rezics[.]com/definition/[a-z0-9-]+-v[0-9]+$'),
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
    civil_possible daterange GENERATED ALWAYS AS (
      CASE WHEN interpretation = 'civil-date' THEN daterange(civil_start_min, civil_end_max, '[]') END) STORED,
    civil_definite daterange GENERATED ALWAYS AS (
      CASE WHEN interpretation = 'civil-date' AND civil_start_max <= civil_end_min
        THEN daterange(civil_start_max, civil_end_min, '[]')
        WHEN interpretation = 'civil-date' THEN 'empty'::daterange END) STORED,
    instant_possible tstzrange GENERATED ALWAYS AS (
      CASE WHEN interpretation = 'instant' THEN tstzrange(instant_start_min, instant_end_max, '[]') END) STORED,
    instant_definite tstzrange GENERATED ALWAYS AS (
      CASE WHEN interpretation = 'instant' AND instant_start_max <= instant_end_min
        THEN tstzrange(instant_start_max, instant_end_min, '[]')
        WHEN interpretation = 'instant' THEN 'empty'::tstzrange END) STORED,
    PRIMARY KEY (generation_id, time_revision, interpretation),
    FOREIGN KEY (generation_id, family) REFERENCES access.derived_generation(id, family) ON DELETE CASCADE,
    CONSTRAINT event_interval_instant_shape CHECK (temporal_kind = 'interval' OR (
      start_state = 'known' AND end_state = 'known' AND end_precision = start_precision
      AND civil_end_min IS NOT DISTINCT FROM civil_start_min
      AND civil_end_max IS NOT DISTINCT FROM civil_start_max
      AND instant_end_min IS NOT DISTINCT FROM instant_start_min
      AND instant_end_max IS NOT DISTINCT FROM instant_start_max)),
    CONSTRAINT event_interval_civil_bounds CHECK (interpretation <> 'civil-date' OR (
      num_nonnulls(instant_start_min, instant_start_max, instant_end_min, instant_end_max) = 0
      AND ((start_state = 'known') = (start_precision IS NOT NULL))
      AND ((start_state = 'known') = (civil_start_min IS NOT NULL AND civil_start_max IS NOT NULL))
      AND (start_state = 'known' OR num_nonnulls(civil_start_min, civil_start_max) = 0)
      AND ((end_state = 'known') = (end_precision IS NOT NULL))
      AND ((end_state = 'known') = (civil_end_min IS NOT NULL AND civil_end_max IS NOT NULL))
      AND (end_state = 'known' OR num_nonnulls(civil_end_min, civil_end_max) = 0)
      AND civil_start_min <= civil_start_max AND civil_end_min <= civil_end_max
      AND civil_start_min <= civil_end_max)),
    CONSTRAINT event_interval_instant_bounds CHECK (interpretation <> 'instant' OR (
      num_nonnulls(civil_start_min, civil_start_max, civil_end_min, civil_end_max) = 0
      AND ((start_state = 'known') = (start_precision IS NOT NULL))
      AND ((start_state = 'known') = (instant_start_min IS NOT NULL AND instant_start_max IS NOT NULL))
      AND (start_state = 'known' OR num_nonnulls(instant_start_min, instant_start_max) = 0)
      AND ((end_state = 'known') = (end_precision IS NOT NULL))
      AND ((end_state = 'known') = (instant_end_min IS NOT NULL AND instant_end_max IS NOT NULL))
      AND (end_state = 'known' OR num_nonnulls(instant_end_min, instant_end_max) = 0)
      AND instant_start_min <= instant_start_max AND instant_end_min <= instant_end_max
      AND instant_start_min <= instant_end_max))
);
-- At most max_retained generations share these range indexes; queries filter
-- generation_id after the bounded overlap probe.
CREATE INDEX event_interval_civil_possible ON access.event_interval_key USING gist (civil_possible)
    WHERE interpretation = 'civil-date';
CREATE INDEX event_interval_instant_possible ON access.event_interval_key USING gist (instant_possible)
    WHERE interpretation = 'instant';
CREATE INDEX event_interval_civil_order ON access.event_interval_key
    (generation_id, time_status, civil_start_min, time_revision) WHERE interpretation = 'civil-date';
CREATE INDEX event_interval_instant_order ON access.event_interval_key
    (generation_id, time_status, instant_start_min, time_revision) WHERE interpretation = 'instant';
CREATE INDEX event_interval_event ON access.event_interval_key (generation_id, event);

-- Civil-date distribution: possible counts include definite counts.
CREATE TABLE access.event_histogram_bucket (
    generation_id uuid NOT NULL,
    family text NOT NULL DEFAULT 'event-interval' CHECK (family = 'event-interval'),
    time_status text NOT NULL CHECK (time_status IN ('actual', 'planned')),
    grain text NOT NULL CHECK (grain IN ('year', 'month', 'day')),
    bucket_start date NOT NULL,
    definite_count bigint NOT NULL CHECK (definite_count >= 0),
    possible_count bigint NOT NULL CHECK (possible_count >= definite_count AND possible_count > 0),
    PRIMARY KEY (generation_id, time_status, grain, bucket_start),
    FOREIGN KEY (generation_id, family) REFERENCES access.derived_generation(id, family) ON DELETE CASCADE,
    CONSTRAINT event_histogram_bucket_aligned CHECK (
      (grain = 'year' AND extract(doy FROM bucket_start) = 1)
      OR (grain = 'month' AND extract(day FROM bucket_start) = 1)
      OR grain = 'day')
);

CREATE TRIGGER event_interval_key_insert_guard AFTER INSERT ON access.event_interval_key
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER event_interval_key_update_guard AFTER UPDATE ON access.event_interval_key
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER event_interval_key_delete_guard AFTER DELETE ON access.event_interval_key
    REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER event_histogram_bucket_insert_guard AFTER INSERT ON access.event_histogram_bucket
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER event_histogram_bucket_update_guard AFTER UPDATE ON access.event_histogram_bucket
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER event_histogram_bucket_delete_guard AFTER DELETE ON access.event_histogram_bucket
    REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
