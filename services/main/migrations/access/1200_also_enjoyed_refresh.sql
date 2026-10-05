-- Signal freshness does not revoke public co-readers; privacy changes do.
-- Existing unclassified changes remain conservative privacy invalidations.
ALTER TABLE access.also_enjoyed_source_change ADD COLUMN privacy boolean NOT NULL DEFAULT true;
CREATE INDEX also_enjoyed_privacy_change ON access.also_enjoyed_source_change (id) WHERE privacy;
ALTER TABLE access.also_enjoyed_source_fence ADD COLUMN privacy_revision bigint NOT NULL DEFAULT 0
    CHECK (privacy_revision BETWEEN 0 AND revision);
UPDATE access.also_enjoyed_source_fence SET privacy_revision=revision;

-- Keep one row per kind per transaction. A signal write cannot swallow a later
-- privacy change, and savepoint rollback restores both marks with their rows.
CREATE FUNCTION access.record_also_enjoyed_source_change(is_private boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE mark text := CASE WHEN is_private THEN 'rezics.also_enjoyed_privacy_changed'
    ELSE 'rezics.also_enjoyed_source_changed' END;
BEGIN
    IF current_setting(mark,true)='on' THEN RETURN; END IF;
    INSERT INTO access.also_enjoyed_source_change (privacy) VALUES (is_private);
    PERFORM set_config(mark,'on',true);
END $$;
CREATE OR REPLACE FUNCTION access.record_also_enjoyed_source_change() RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM access.record_also_enjoyed_source_change(true); END $$;
CREATE OR REPLACE FUNCTION access.advance_also_enjoyed_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    PERFORM access.record_also_enjoyed_source_change(TG_TABLE_NAME NOT IN
        ('rating_aggregate_head','rating_aggregate_context') OR TG_OP IN ('DELETE','TRUNCATE'));
    RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION access.fold_also_enjoyed_source_changes(OUT basis bigint, OUT changed boolean)
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
BEGIN
    SELECT f.revision,false INTO basis,changed FROM access.also_enjoyed_source_fence f
        WHERE f.id AND NOT EXISTS (SELECT 1 FROM access.also_enjoyed_source_change);
    IF FOUND THEN RETURN; END IF;
    PERFORM 1 FROM access.also_enjoyed_source_fence WHERE id FOR UPDATE;
    WITH folded AS (DELETE FROM access.also_enjoyed_source_change WHERE id IN
        (SELECT id FROM access.also_enjoyed_source_change ORDER BY id LIMIT 100000) RETURNING privacy)
    UPDATE access.also_enjoyed_source_fence SET revision=revision+1,
        privacy_revision=CASE WHEN EXISTS (SELECT 1 FROM folded WHERE privacy)
            THEN revision+1 ELSE privacy_revision END WHERE id AND EXISTS (SELECT 1 FROM folded);
    PERFORM set_config('rezics.also_enjoyed_source_changed','',true);
    PERFORM set_config('rezics.also_enjoyed_privacy_changed','',true);
    SELECT f.revision,EXISTS (SELECT 1 FROM access.also_enjoyed_source_change) INTO basis,changed
        FROM access.also_enjoyed_source_fence f WHERE f.id;
END $$;
