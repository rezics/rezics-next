-- Logical generations share unchanged physical rows. A delta closes and adds
-- only its Work/term/Concept versions; retained generations still see their cut.
ALTER TABLE access.discovery_generation
    ADD COLUMN storage_generation uuid REFERENCES access.discovery_generation(generation_id),
    ADD COLUMN storage_version bigint NOT NULL DEFAULT 0 CHECK (storage_version >= 0),
    ADD COLUMN rebuild_pending boolean NOT NULL DEFAULT false,
    ADD COLUMN catchup_works jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(catchup_works) = 'array'
        AND jsonb_array_length(catchup_works) <= 2000);
CREATE INDEX discovery_storage_generations ON access.discovery_generation
    (storage_generation, storage_version);
ALTER TABLE access.discovery_entry ADD COLUMN entry_version bigint NOT NULL DEFAULT 0,
    ADD COLUMN retired_version bigint CHECK (retired_version > entry_version);
ALTER TABLE access.discovery_entry DROP CONSTRAINT discovery_entry_pkey;
ALTER TABLE access.discovery_entry ADD PRIMARY KEY (generation_id, work, work_type, term, entry_version);
CREATE INDEX discovery_entry_retired ON access.discovery_entry (generation_id, retired_version)
    WHERE retired_version IS NOT NULL;
ALTER TABLE access.discovery_term_count ADD COLUMN entry_version bigint NOT NULL DEFAULT 0,
    ADD COLUMN retired_version bigint CHECK (retired_version > entry_version);
ALTER TABLE access.discovery_term_count DROP CONSTRAINT discovery_term_count_pkey;
ALTER TABLE access.discovery_term_count ADD PRIMARY KEY (generation_id, term, entry_version);
CREATE TABLE access.discovery_concept_count (
    generation_id uuid NOT NULL REFERENCES access.discovery_generation(generation_id),
    concept text COLLATE "C" NOT NULL,
    work_count bigint NOT NULL CHECK (work_count > 0),
    entry_version bigint NOT NULL DEFAULT 0,
    retired_version bigint CHECK (retired_version > entry_version),
    PRIMARY KEY (generation_id, concept, entry_version)
);
CREATE INDEX discovery_concept_count_seek ON access.discovery_concept_count
    (generation_id, work_count DESC, concept);
INSERT INTO access.discovery_concept_count (generation_id, concept, work_count)
    SELECT generation_id, concept, concept_count FROM access.discovery_term_count
    WHERE concept_leader AND concept_count > 0;

-- SQL functions inline into the indexed posting-list seeks. A logical id is
-- returned, so all existing equality predicates keep their public meaning.
CREATE FUNCTION access.discovery_entries(uuid) RETURNS SETOF access.discovery_entry
LANGUAGE sql STABLE AS $$
    SELECT $1, e.work, e.work_type, e.term, e.recent_order, e.rating_count,
        e.rating_sum, e.rating_order, e.payload, e.entry_version, e.retired_version
    FROM access.discovery_entry e
    WHERE e.generation_id = coalesce((SELECT storage_generation FROM access.discovery_generation WHERE generation_id=$1), $1)
      AND e.entry_version <= coalesce((SELECT storage_version FROM access.discovery_generation WHERE generation_id=$1), 0)
      AND (e.retired_version IS NULL OR e.retired_version > coalesce((SELECT storage_version FROM access.discovery_generation WHERE generation_id=$1), 0))
$$;
CREATE FUNCTION access.discovery_terms(uuid) RETURNS SETOF access.discovery_term_count
LANGUAGE sql STABLE AS $$
    SELECT $1, t.term, t.concept, t.work_count, t.concept_count, t.concept_leader,
        t.entry_version, t.retired_version FROM access.discovery_term_count t
    WHERE t.generation_id = coalesce((SELECT storage_generation FROM access.discovery_generation WHERE generation_id=$1), $1)
      AND t.entry_version <= coalesce((SELECT storage_version FROM access.discovery_generation WHERE generation_id=$1), 0)
      AND (t.retired_version IS NULL OR t.retired_version > coalesce((SELECT storage_version FROM access.discovery_generation WHERE generation_id=$1), 0))
$$;
CREATE FUNCTION access.discovery_concepts(uuid) RETURNS SETOF access.discovery_concept_count
LANGUAGE sql STABLE AS $$
    SELECT $1, c.concept, c.work_count, c.entry_version, c.retired_version FROM access.discovery_concept_count c
    WHERE c.generation_id = coalesce((SELECT storage_generation FROM access.discovery_generation WHERE generation_id=$1), $1)
      AND c.entry_version <= coalesce((SELECT storage_version FROM access.discovery_generation WHERE generation_id=$1), 0)
      AND (c.retired_version IS NULL OR c.retired_version > coalesce((SELECT storage_version FROM access.discovery_generation WHERE generation_id=$1), 0))
$$;

-- Coverage is mutable evidence about an immutable population, not a new build.
CREATE TABLE access.discovery_coverage (
    generation_id uuid PRIMARY KEY REFERENCES access.discovery_generation(generation_id) ON DELETE CASCADE,
    sequence numeric(20,0) NOT NULL CHECK (sequence >= 0)
);
INSERT INTO access.discovery_coverage SELECT generation_id, source_sequence FROM access.discovery_generation;

-- Rating heads have Work/Context-addressed graph events. They must not also
-- invalidate every scope via the global Access fence. Other safety fences stay.
DROP TRIGGER discovery_source_changed ON access.rating_aggregate_head;
DROP TRIGGER discovery_source_truncated ON access.rating_aggregate_head;
DROP TRIGGER discovery_source_changed ON access.rating_aggregate_context;
DROP TRIGGER discovery_source_truncated ON access.rating_aggregate_context;

CREATE OR REPLACE FUNCTION access.discovery_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM access.derived_generation
        WHERE id=NEW.generation_id AND family='discovery' AND state='building') THEN
        RAISE EXCEPTION 'discovery changes only while building' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND ((NEW.generation_id, NEW.family, NEW.scope, NEW.realm, NEW.principal_id,
        NEW.context, NEW.source_epoch, NEW.access_revision, NEW.recovery_generation)
        IS DISTINCT FROM (OLD.generation_id, OLD.family, OLD.scope, OLD.realm, OLD.principal_id,
        OLD.context, OLD.source_epoch, OLD.access_revision, OLD.recovery_generation)
        OR NEW.source_sequence < OLD.source_sequence OR (OLD.complete AND NOT NEW.complete)
        OR (NEW.checkpoint < OLD.checkpoint AND NEW.source_sequence = OLD.source_sequence)) THEN
        RAISE EXCEPTION 'discovery identity is immutable; catch-up advances the cut' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND (NEW.storage_generation,NEW.storage_version) IS DISTINCT FROM (OLD.storage_generation,OLD.storage_version)
        AND NOT (current_setting('rezics.discovery_mode',true)='rebuild' AND NEW.source_sequence>OLD.source_sequence
            AND NEW.storage_generation IS NULL AND NEW.storage_version=0) THEN
        RAISE EXCEPTION 'discovery storage identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;

-- Only a leased building generation can close older intervals in its own
-- storage family. Old payloads remain immutable. Terminal cleanup uses a
-- separate mode and cannot delete rows visible to any retained/live generation.
CREATE FUNCTION access.discovery_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target access.discovery_generation; mode text;
BEGIN
    mode := current_setting('rezics.discovery_mode', true);
    IF TG_OP='DELETE' AND mode='purge' THEN
        IF EXISTS (SELECT 1 FROM changed e JOIN access.discovery_generation d
            ON coalesce(d.storage_generation,d.generation_id)=e.generation_id
            JOIN access.derived_generation g ON g.id=d.generation_id
            WHERE (g.state IN ('building','ready') OR (g.state IN ('superseded','expired')
                AND g.finished_at > statement_timestamp()-interval '6 minutes'))
              AND e.entry_version <= d.storage_version
              AND (e.retired_version IS NULL OR e.retired_version > d.storage_version)) THEN
            RAISE EXCEPTION 'retained discovery versions cannot be purged' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END IF;
    SELECT d.* INTO target FROM access.discovery_generation d JOIN access.derived_generation g ON g.id=d.generation_id
        WHERE d.generation_id=nullif(current_setting('rezics.discovery_writer',true),'')::uuid
          AND (g.state='building' OR (mode='rollback' AND g.state IN ('failed','cancelled','expired')));
    IF target.storage_generation IS NOT NULL AND mode='rollback' AND EXISTS (
        SELECT 1 FROM access.discovery_generation d JOIN access.derived_generation g ON g.id=d.generation_id
        WHERE coalesce(d.storage_generation,d.generation_id)=target.storage_generation
          AND d.generation_id<>target.generation_id AND d.storage_version>=target.storage_version
          AND g.state IN ('building','ready','superseded')) THEN
        RAISE EXCEPTION 'published discovery versions cannot be rolled back' USING ERRCODE='23514';
    END IF;
    IF target IS NULL THEN
        -- Preserve direct full-build fixture/operator inserts and terminal deletes.
        IF TG_OP='DELETE' THEN
            IF EXISTS (SELECT 1 FROM changed e JOIN access.derived_generation g ON g.id=e.generation_id WHERE g.state='ready') THEN
                RAISE EXCEPTION 'ready discovery rows are immutable' USING ERRCODE='23514';
            END IF;
        ELSIF EXISTS (SELECT 1 FROM changed e LEFT JOIN access.derived_generation g ON g.id=e.generation_id
            WHERE g.state IS DISTINCT FROM 'building' OR e.entry_version<>0) THEN
            RAISE EXCEPTION 'discovery rows need a building writer' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM changed e WHERE e.generation_id<>coalesce(target.storage_generation,target.generation_id)
        OR (TG_OP='INSERT' AND e.entry_version<>target.storage_version)
        OR (TG_OP='DELETE' AND e.entry_version<>target.storage_version)) THEN
        RAISE EXCEPTION 'discovery version writer differs' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' THEN
        IF EXISTS (SELECT 1 FROM changed n JOIN previous o ON to_jsonb(n)-'retired_version'=to_jsonb(o)-'retired_version'
            WHERE n.entry_version<target.storage_version AND
              NOT ((o.retired_version IS NULL AND n.retired_version=target.storage_version)
                OR (mode='rollback' AND o.retired_version=target.storage_version AND n.retired_version IS NULL)))
            OR (SELECT count(*) FROM changed WHERE entry_version<target.storage_version)<>
               (SELECT count(*) FROM changed n JOIN previous o ON to_jsonb(n)-'retired_version'=to_jsonb(o)-'retired_version'
                WHERE n.entry_version<target.storage_version) THEN
            RAISE EXCEPTION 'historical discovery payload is immutable' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NULL;
END $$;
DO $$ DECLARE tab text; prefix text; BEGIN
    FOREACH tab IN ARRAY ARRAY['discovery_entry','discovery_term_count','discovery_concept_count'] LOOP
        prefix := CASE tab WHEN 'discovery_entry' THEN 'discovery_entry' WHEN 'discovery_term_count' THEN 'discovery_term' ELSE 'discovery_concept' END;
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON access.%I',prefix||'_insert_guard',tab);
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON access.%I',prefix||'_update_guard',tab);
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON access.%I',prefix||'_delete_guard',tab);
        EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON access.%I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.discovery_version_guard()',prefix||'_insert_guard',tab);
        EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON access.%I REFERENCING NEW TABLE AS changed OLD TABLE AS previous FOR EACH STATEMENT EXECUTE FUNCTION access.discovery_version_guard()',prefix||'_update_guard',tab);
        EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON access.%I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.discovery_version_guard()',prefix||'_delete_guard',tab);
    END LOOP;
END $$;
