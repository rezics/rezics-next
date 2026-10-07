-- A consumed Event head proves its own retained prefix, not a moving Main tail.
ALTER TABLE access.event_temporal_checkpoint ADD COLUMN initial_sequence numeric
    CHECK (initial_sequence >= 0);
ALTER TABLE access.event_temporal_checkpoint
    ADD COLUMN actual_source_sequence numeric NOT NULL DEFAULT 0,
    ADD COLUMN actual_source_event text,
    ADD COLUMN actual_prefix numeric NOT NULL DEFAULT 0,
    ADD COLUMN planned_source_sequence numeric NOT NULL DEFAULT 0,
    ADD COLUMN planned_source_event text,
    ADD COLUMN planned_prefix numeric NOT NULL DEFAULT 0;
ALTER TABLE access.event_temporal_applied ADD COLUMN journal_sequence numeric
    CHECK (journal_sequence > 0);
ALTER TABLE access.event_temporal_pending ADD COLUMN journal_revision text;
-- Qualify prior applied heads by replaying the same indexed journal once.
UPDATE access.event_temporal_checkpoint SET relay_sequence=0,initial_sequence=NULL,
    backfill_complete=false,processed=0,actual_revision='',planned_revision='';
ALTER TABLE access.event_temporal_window
    ADD COLUMN actual_revision numeric NOT NULL DEFAULT 1,
    ADD COLUMN planned_revision numeric NOT NULL DEFAULT 1,
    ADD COLUMN scan_started_at timestamptz,
    ADD COLUMN work_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE access.event_temporal_window SET scan_started_at=created_at WHERE state<>'queued';
CREATE INDEX event_temporal_window_fair_work ON access.event_temporal_window (work_at,id)
    WHERE state IN ('queued','building');

-- Typed old/new effects support indexed geometric and unvisited-window fences.
ALTER TABLE access.event_temporal_window_update
    ADD COLUMN ready boolean NOT NULL DEFAULT true,
    ADD COLUMN next_job bigint REFERENCES access.event_temporal_window_update(id) DEFERRABLE INITIALLY DEFERRED,
    ADD COLUMN target numrange,
    ADD COLUMN last_window uuid,
    ADD COLUMN unvisited_windows numrange,
    ADD COLUMN existing_windows tstzrange GENERATED ALWAYS AS (tstzrange(NULL,created_at,'[]')) STORED,
    ADD COLUMN civil_effect datemultirange,
    ADD COLUMN instant_effect tstzmultirange,
    ADD COLUMN unsupported_effect datemultirange,
    ADD COLUMN work_at timestamptz NOT NULL DEFAULT clock_timestamp();
WITH ordinals AS (
    SELECT j.id,
      (SELECT sum(get_byte(uuid_send(regexp_replace(j.event,'.*/','')::uuid),b)*power(256::numeric,15-b))
       FROM generate_series(0,15) b) AS target,
      (SELECT sum(get_byte(uuid_send(j.after_window),b)*power(256::numeric,15-b))
       FROM generate_series(0,15) b) AS after_window,
      (SELECT id FROM access.event_temporal_window ORDER BY id DESC LIMIT 1) AS last_window
    FROM access.event_temporal_window_update j
), bounds AS (
    SELECT o.*, (SELECT sum(get_byte(uuid_send(o.last_window),b)*power(256::numeric,15-b))
        FROM generate_series(0,15) b) AS last_ordinal FROM ordinals o
)
UPDATE access.event_temporal_window_update j SET
    target=numrange(o.target,o.target,'[]'),last_window=o.last_window,
    unvisited_windows=numrange(coalesce(o.after_window,0),o.last_ordinal,
      CASE WHEN o.after_window IS NULL THEN '[]' ELSE '(]' END),
    civil_effect=datemultirange(
      CASE WHEN old_interval IS NULL THEN 'empty'::daterange ELSE daterange((old_interval->>'civil_start_min')::date,(old_interval->>'civil_end_max')::date,'[]') END,
      CASE WHEN new_interval IS NULL THEN 'empty'::daterange ELSE daterange((new_interval->>'civil_start_min')::date,(new_interval->>'civil_end_max')::date,'[]') END),
    instant_effect=tstzmultirange(
      CASE WHEN (old_interval->>'instant_supported')::boolean IS TRUE THEN tstzrange((old_interval->>'instant_start_min')::timestamptz,(old_interval->>'instant_end_max')::timestamptz,'[]') ELSE 'empty'::tstzrange END,
      CASE WHEN (new_interval->>'instant_supported')::boolean IS TRUE THEN tstzrange((new_interval->>'instant_start_min')::timestamptz,(new_interval->>'instant_end_max')::timestamptz,'[]') ELSE 'empty'::tstzrange END),
    unsupported_effect=datemultirange(
      CASE WHEN (old_interval->>'instant_supported')::boolean IS FALSE THEN daterange((old_interval->>'civil_start_min')::date,(old_interval->>'civil_end_max')::date,'[]') ELSE 'empty'::daterange END,
      CASE WHEN (new_interval->>'instant_supported')::boolean IS FALSE THEN daterange((new_interval->>'civil_start_min')::date,(new_interval->>'civil_end_max')::date,'[]') ELSE 'empty'::daterange END)
FROM bounds o WHERE j.id=o.id;
ALTER TABLE access.event_temporal_window_update ALTER COLUMN target SET NOT NULL,
    ALTER COLUMN unvisited_windows SET NOT NULL,ALTER COLUMN civil_effect SET NOT NULL,
    ALTER COLUMN instant_effect SET NOT NULL,ALTER COLUMN unsupported_effect SET NOT NULL;
WITH ordered AS (
    SELECT id,lead(id) OVER(PARTITION BY event,time_status ORDER BY id) AS next_job,
      row_number() OVER(PARTITION BY event,time_status ORDER BY id)=1 AS ready
    FROM access.event_temporal_window_update
) UPDATE access.event_temporal_window_update j SET ready=o.ready,next_job=o.next_job FROM ordered o WHERE j.id=o.id;
CREATE INDEX event_temporal_effect_work ON access.event_temporal_window_update (work_at,id) WHERE ready;
CREATE INDEX event_temporal_effect_target_order ON access.event_temporal_window_update (event,time_status,id);
-- Each status can establish absence without filtering all jobs in the other.
DO $$
DECLARE geometry text; status text;
BEGIN
  FOREACH geometry IN ARRAY ARRAY['civil_effect','instant_effect','unsupported_effect'] LOOP
    EXECUTE format('CREATE INDEX event_temporal_%s_scope ON access.event_temporal_window_update USING gist (%I,unvisited_windows,existing_windows,target)',geometry,geometry);
    FOREACH status IN ARRAY ARRAY['actual','planned'] LOOP
      EXECUTE format('CREATE INDEX event_temporal_%s_%s_scope ON access.event_temporal_window_update USING gist (%I,unvisited_windows,existing_windows,target) WHERE time_status=%L',geometry,status,geometry,status);
    END LOOP;
  END LOOP;
END $$;

-- Sparse unsupported values also have a bounded empty-extent probe.
CREATE INDEX event_temporal_unsupported_civil ON access.event_temporal_interval
    USING gist (civil_possible) WHERE NOT instant_supported;
