ALTER TABLE reader.also_enjoyed_source_change ADD COLUMN privacy boolean NOT NULL DEFAULT true;
CREATE INDEX also_enjoyed_privacy_change ON reader.also_enjoyed_source_change (id) WHERE privacy;
ALTER TABLE reader.also_enjoyed_source_fence ADD COLUMN privacy_revision bigint NOT NULL DEFAULT 0
    CHECK (privacy_revision BETWEEN 0 AND revision);
UPDATE reader.also_enjoyed_source_fence SET privacy_revision=revision;

CREATE FUNCTION reader.record_also_enjoyed_source_change(is_private boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE mark text := CASE WHEN is_private THEN 'rezics.also_enjoyed_shelf_privacy_changed'
    ELSE 'rezics.also_enjoyed_shelf_changed' END;
BEGIN
    IF current_setting(mark,true)='on' THEN RETURN; END IF;
    INSERT INTO reader.also_enjoyed_source_change (privacy) VALUES (is_private);
    PERFORM set_config(mark,'on',true);
END $$;
CREATE OR REPLACE FUNCTION reader.record_also_enjoyed_source_change() RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM reader.record_also_enjoyed_source_change(true); END $$;
CREATE OR REPLACE FUNCTION reader.advance_also_enjoyed_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND (NEW.agent,NEW.work,NEW.status)
        IS NOT DISTINCT FROM (OLD.agent,OLD.work,OLD.status) THEN RETURN NULL; END IF;
    -- A previously cleared shelf can still contribute to a retained generation.
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        PERFORM reader.record_also_enjoyed_source_change(true);
        RETURN NULL;
    END IF;
    IF coalesce(to_jsonb(OLD)->>'status','') NOT IN ('read','reading')
        AND coalesce(to_jsonb(NEW)->>'status','') NOT IN ('read','reading') THEN RETURN NULL; END IF;
    -- Normal shelf commands update or clear a status in place. Physical removal
    -- and inventory truncation can be erasure and must revoke retained signals.
    PERFORM reader.record_also_enjoyed_source_change(false);
    RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION reader.fold_also_enjoyed_source_changes(OUT basis bigint, OUT changed boolean)
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
BEGIN
    SELECT f.revision,false INTO basis,changed FROM reader.also_enjoyed_source_fence f
        WHERE f.id AND NOT EXISTS (SELECT 1 FROM reader.also_enjoyed_source_change);
    IF FOUND THEN RETURN; END IF;
    PERFORM 1 FROM reader.also_enjoyed_source_fence WHERE id FOR UPDATE;
    WITH folded AS (DELETE FROM reader.also_enjoyed_source_change WHERE id IN
        (SELECT id FROM reader.also_enjoyed_source_change ORDER BY id LIMIT 100000) RETURNING privacy)
    UPDATE reader.also_enjoyed_source_fence SET revision=revision+1,
        privacy_revision=CASE WHEN EXISTS (SELECT 1 FROM folded WHERE privacy)
            THEN revision+1 ELSE privacy_revision END WHERE id AND EXISTS (SELECT 1 FROM folded);
    PERFORM set_config('rezics.also_enjoyed_shelf_changed','',true);
    PERFORM set_config('rezics.also_enjoyed_shelf_privacy_changed','',true);
    SELECT f.revision,EXISTS (SELECT 1 FROM reader.also_enjoyed_source_change) INTO basis,changed
        FROM reader.also_enjoyed_source_fence f WHERE f.id;
END $$;
