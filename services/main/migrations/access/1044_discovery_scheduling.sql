-- Global browse and standing rating scopes have their own due-index lane.
-- A finite burst gives background Realms progress without queue-length latency
-- for the scopes used by health/readers.
ALTER TABLE access.discovery_refresh ADD COLUMN priority smallint GENERATED ALWAYS AS
    (CASE WHEN basis->>'scope'='global' THEN 0 ELSE 1 END) STORED;
CREATE INDEX discovery_refresh_lane ON access.discovery_refresh (priority,due_at,scope_key);
CREATE INDEX discovery_retirement_age ON access.derived_generation (family,finished_at,id)
    WHERE state IN ('cancelled','failed','superseded','expired');
CREATE INDEX discovery_term_retired ON access.discovery_term_count (generation_id,retired_version)
    WHERE retired_version IS NOT NULL;
ALTER TABLE access.discovery_retirement ADD COLUMN due_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '6 minutes');
UPDATE access.discovery_retirement r SET due_at=g.finished_at+interval '6 minutes'
    FROM access.derived_generation g WHERE g.id=r.generation_id;
CREATE INDEX discovery_retirement_due ON access.discovery_retirement (due_at,generation_id);
-- Delta maintenance sees only live rows. Retained history for another Work or
-- another scope cannot turn the replacement probes into a history scan.
CREATE INDEX discovery_entry_live ON access.discovery_entry (generation_id,work,work_type,term)
    WHERE retired_version IS NULL;
CREATE INDEX discovery_entry_version ON access.discovery_entry (generation_id,entry_version);
CREATE INDEX discovery_term_live ON access.discovery_term_count (generation_id,term)
    WHERE retired_version IS NULL;
CREATE INDEX discovery_concept_live ON access.discovery_concept_count (generation_id,concept)
    WHERE retired_version IS NULL;
CREATE INDEX discovery_concept_retired ON access.discovery_concept_count (generation_id,retired_version)
    WHERE retired_version IS NOT NULL;
-- Include superseded builds once their cursor interval ends, even if idle
-- scopes never activate another generation to expire them by retained count.
CREATE OR REPLACE FUNCTION access.retire_discovery_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.family='discovery' AND NEW.state IN ('cancelled','failed','superseded','expired') THEN
        INSERT INTO access.discovery_retirement (generation_id,due_at) VALUES (NEW.id,NEW.finished_at+interval '6 minutes')
            ON CONFLICT (generation_id) DO UPDATE SET due_at=least(access.discovery_retirement.due_at,EXCLUDED.due_at);
    END IF;
    RETURN NULL;
END $$;
INSERT INTO access.discovery_retirement (generation_id,due_at) SELECT d.generation_id,g.finished_at+interval '6 minutes' FROM access.discovery_generation d
    JOIN access.derived_generation g ON g.id=d.generation_id
    WHERE g.state IN ('cancelled','failed','superseded','expired') ON CONFLICT DO NOTHING;

-- Creating an account or refreshing its assertion cannot change an existing
-- rating population. Active-state changes remain a named safety rebuild.
-- Preserve every other source-fence rule from migration 315.
CREATE OR REPLACE FUNCTION access.advance_discovery_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME='principal' AND (TG_OP='INSERT' OR (TG_OP='UPDATE'
        AND to_jsonb(NEW)->'active' IS NOT DISTINCT FROM to_jsonb(OLD)->'active')) THEN RETURN NULL; END IF;
    IF TG_OP='INSERT' AND (to_jsonb(NEW)->>'generation')::bigint=0 THEN
        IF TG_TABLE_NAME='judgment_concept_hint' AND to_jsonb(NEW)->>'hint' IS NULL THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME='judgment_aggregate'
            AND (to_jsonb(NEW)->>'fit_negative')::bigint=0 AND (to_jsonb(NEW)->>'fit_positive')::bigint=0
            AND (to_jsonb(NEW)->>'spoiler_none')::bigint=0 AND (to_jsonb(NEW)->>'spoiler_minor')::bigint=0
            AND (to_jsonb(NEW)->>'spoiler_major')::bigint=0 THEN RETURN NULL; END IF;
    END IF;
    UPDATE access.discovery_source_fence SET revision=revision+1 WHERE id;
    RETURN NULL;
END $$;
