-- Source writers no longer update the fence rows they all shared until commit.
-- A writing transaction appends one change row instead; only a builder folds
-- the visible rows into the fence revision, and only folders lock the fence.
-- A basis is the revision a fold returned. It stays current while the revision
-- is equal and no change row exists. A transaction that has not committed is
-- invisible to every fold, so its row survives and outdates the basis when it
-- commits, whatever its transaction id. No transaction counter is involved:
-- rows and revision survive a logical restore together.
CREATE TABLE access.discovery_source_change (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
CREATE TABLE access.also_enjoyed_source_change (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);

-- Any source change outdates every basis, so one row per transaction says it
-- all. The transaction-local mark reverts with a rolled-back savepoint.
CREATE FUNCTION access.record_discovery_source_change() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('rezics.discovery_source_changed', true) = 'on' THEN RETURN; END IF;
    INSERT INTO access.discovery_source_change DEFAULT VALUES;
    PERFORM set_config('rezics.discovery_source_changed', 'on', true);
END $$;
CREATE FUNCTION access.record_also_enjoyed_source_change() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('rezics.also_enjoyed_source_changed', true) = 'on' THEN RETURN; END IF;
    INSERT INTO access.also_enjoyed_source_change DEFAULT VALUES;
    PERFORM set_config('rezics.also_enjoyed_source_changed', 'on', true);
END $$;

-- The filters of migrations 315, 1044, 1060 and 785 are unchanged.
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
    PERFORM access.record_discovery_source_change();
    RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION access.advance_discovery_rating_repair_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    IF TG_OP IN ('INSERT','UPDATE')
        AND current_setting('rezics.discovery_rating_outbox',true)='on' THEN RETURN NULL; END IF;
    PERFORM access.record_discovery_source_change();
    RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION access.advance_also_enjoyed_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    PERFORM access.record_also_enjoyed_source_change();
    RETURN NULL;
END $$;

-- Folders serialize on the fence row, after the cheap unlocked check that
-- nothing is pending. Each call folds at most 100,000 rows; any rows left keep
-- reporting a change until the next fold. Clearing the mark lets a later change
-- in the folding transaction append again.
CREATE FUNCTION access.fold_discovery_source_changes(OUT basis bigint, OUT changed boolean)
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
BEGIN
    SELECT f.revision, false INTO basis, changed FROM access.discovery_source_fence f
        WHERE f.id AND NOT EXISTS (SELECT 1 FROM access.discovery_source_change);
    IF FOUND THEN RETURN; END IF;
    PERFORM 1 FROM access.discovery_source_fence WHERE id FOR UPDATE;
    WITH folded AS (DELETE FROM access.discovery_source_change WHERE id IN
        (SELECT id FROM access.discovery_source_change ORDER BY id LIMIT 100000) RETURNING id)
    UPDATE access.discovery_source_fence SET revision = revision + 1
        WHERE id AND EXISTS (SELECT 1 FROM folded);
    PERFORM set_config('rezics.discovery_source_changed', '', true);
    SELECT f.revision, EXISTS (SELECT 1 FROM access.discovery_source_change) INTO basis, changed
        FROM access.discovery_source_fence f WHERE f.id;
END $$;
CREATE FUNCTION access.fold_also_enjoyed_source_changes(OUT basis bigint, OUT changed boolean)
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
BEGIN
    SELECT f.revision, false INTO basis, changed FROM access.also_enjoyed_source_fence f
        WHERE f.id AND NOT EXISTS (SELECT 1 FROM access.also_enjoyed_source_change);
    IF FOUND THEN RETURN; END IF;
    PERFORM 1 FROM access.also_enjoyed_source_fence WHERE id FOR UPDATE;
    WITH folded AS (DELETE FROM access.also_enjoyed_source_change WHERE id IN
        (SELECT id FROM access.also_enjoyed_source_change ORDER BY id LIMIT 100000) RETURNING id)
    UPDATE access.also_enjoyed_source_fence SET revision = revision + 1
        WHERE id AND EXISTS (SELECT 1 FROM folded);
    PERFORM set_config('rezics.also_enjoyed_source_changed', '', true);
    SELECT f.revision, EXISTS (SELECT 1 FROM access.also_enjoyed_source_change) INTO basis, changed
        FROM access.also_enjoyed_source_fence f WHERE f.id;
END $$;
