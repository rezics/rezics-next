-- Change rows name what they reach, so a basis is outdated only by changes to
-- its own inputs. context_key '' is a scope-wide safety change that reaches
-- every basis (moderation, deactivation, recovery, rating repairs). Otherwise it
-- is the judgment context: a vote reaches the Work behind its Statement there,
-- and a spoiler hint (statement '') every Work of its Concept there. Rows
-- written before this migration become scope-wide.
ALTER TABLE access.discovery_source_change
    ADD COLUMN context_key text NOT NULL DEFAULT '',
    ADD COLUMN statement text NOT NULL DEFAULT '';
CREATE INDEX discovery_source_change_context ON access.discovery_source_change (context_key);

-- The revision of the latest fold that folded a change to each key. A basis at
-- revision R is outdated by exactly the keys above R; overwriting an older
-- revision loses nothing, because revisions only grow. One row per key keeps
-- the table bounded by the Statements ever judged, not by the votes.
CREATE TABLE access.discovery_source_key (
    context_key text NOT NULL,
    statement text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    PRIMARY KEY (context_key, statement)
);
CREATE INDEX discovery_source_key_revision ON access.discovery_source_key (context_key, revision);
-- Folds before this migration recorded no keys. Every basis older than the
-- current revision rebuilds once instead of treating those folds as covered.
INSERT INTO access.discovery_source_key (context_key, statement, revision)
    SELECT '', '', revision FROM access.discovery_source_fence WHERE id AND revision > 0;

-- A refresh that resolves every key above a generation's basis to Works
-- outside its population acknowledges them without a new generation.
ALTER TABLE access.discovery_coverage ADD COLUMN access_revision bigint CHECK (access_revision >= 0);

CREATE FUNCTION access.record_discovery_judgment_change(judged_context text, judged_statement text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- A scope-wide row in this transaction already reaches every key.
    IF current_setting('rezics.discovery_source_changed', true) = 'on' THEN RETURN; END IF;
    INSERT INTO access.discovery_source_change (context_key, statement)
        VALUES (judged_context, judged_statement);
END $$;

-- The filters of migrations 315, 1044 and 1160 are unchanged.
CREATE OR REPLACE FUNCTION access.advance_discovery_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb := to_jsonb(OLD); new_row jsonb := to_jsonb(NEW);
BEGIN
    IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME='principal' AND (TG_OP='INSERT' OR (TG_OP='UPDATE'
        AND new_row->'active' IS NOT DISTINCT FROM old_row->'active')) THEN RETURN NULL; END IF;
    IF TG_OP='INSERT' AND (new_row->>'generation')::bigint=0 THEN
        IF TG_TABLE_NAME='judgment_concept_hint' AND new_row->>'hint' IS NULL THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME='judgment_aggregate'
            AND (new_row->>'fit_negative')::bigint=0 AND (new_row->>'fit_positive')::bigint=0
            AND (new_row->>'spoiler_none')::bigint=0 AND (new_row->>'spoiler_minor')::bigint=0
            AND (new_row->>'spoiler_major')::bigint=0 THEN RETURN NULL; END IF;
    END IF;
    IF TG_TABLE_NAME IN ('judgment_aggregate', 'judgment_concept_hint') AND TG_OP <> 'TRUNCATE' THEN
        IF old_row IS NOT NULL THEN
            PERFORM access.record_discovery_judgment_change(old_row->>'context_key',
                coalesce(old_row->>'statement', ''));
        END IF;
        IF new_row IS NOT NULL AND (old_row IS NULL OR (new_row->>'context_key', new_row->>'statement')
            IS DISTINCT FROM (old_row->>'context_key', old_row->>'statement')) THEN
            PERFORM access.record_discovery_judgment_change(new_row->>'context_key',
                coalesce(new_row->>'statement', ''));
        END IF;
        RETURN NULL;
    END IF;
    PERFORM access.record_discovery_source_change();
    RETURN NULL;
END $$;

-- As in migration 1160, plus the keys of the folded rows at the new revision.
CREATE OR REPLACE FUNCTION access.fold_discovery_source_changes(OUT basis bigint, OUT changed boolean)
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
BEGIN
    SELECT f.revision, false INTO basis, changed FROM access.discovery_source_fence f
        WHERE f.id AND NOT EXISTS (SELECT 1 FROM access.discovery_source_change);
    IF FOUND THEN RETURN; END IF;
    PERFORM 1 FROM access.discovery_source_fence WHERE id FOR UPDATE;
    WITH folded AS (DELETE FROM access.discovery_source_change WHERE id IN
        (SELECT id FROM access.discovery_source_change ORDER BY id LIMIT 100000)
        RETURNING context_key, statement),
    advanced AS (UPDATE access.discovery_source_fence SET revision = revision + 1
        WHERE id AND EXISTS (SELECT 1 FROM folded) RETURNING revision)
    INSERT INTO access.discovery_source_key (context_key, statement, revision)
        SELECT DISTINCT folded.context_key, folded.statement, advanced.revision
        FROM folded CROSS JOIN advanced
    ON CONFLICT (context_key, statement) DO UPDATE SET revision = EXCLUDED.revision;
    PERFORM set_config('rezics.discovery_source_changed', '', true);
    SELECT f.revision, EXISTS (SELECT 1 FROM access.discovery_source_change) INTO basis, changed
        FROM access.discovery_source_fence f WHERE f.id;
END $$;
