-- One chosen alias spelling. Display labels and readable suffixes belong to
-- resource representations, rather than this permanent key inventory.
DO $$
DECLARE former text; row record;
BEGIN
  FOREACH former IN ARRAY ARRAY['name_reserved_word','name_registry','name_history',
    'name_receipt','name_graph_import','name_graph_import_report'] LOOP
    IF to_regclass('access.' || former) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE access.%I RENAME TO %I', former, replace(former,'name_','alias_'));
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'access'
    AND table_name = 'alias_graph_import_report' AND column_name = 'legacy_name') THEN
    ALTER TABLE access.alias_graph_import_report RENAME COLUMN legacy_name TO legacy_alias;
  END IF;
  -- Renaming a relation preserves its constraints, foreign keys and view OIDs.
  -- Rename the attached vocabulary too, including primary-key backing indexes.
  FOR row IN SELECT c.conname, t.relname FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'access' AND t.relname IN ('alias_reserved_word','alias_registry',
      'alias_history','alias_receipt','alias_graph_import','alias_graph_import_report')
      AND c.conname LIKE 'name\_%' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER TABLE access.%I RENAME CONSTRAINT %I TO %I',
      row.relname, row.conname, replace(row.conname,'name_','alias_'));
  END LOOP;
  FOR row IN SELECT indexname FROM pg_indexes WHERE schemaname = 'access'
    AND (indexname LIKE 'name\_%' ESCAPE '\' OR indexname = 'realm_member_name_registry_search')
  LOOP
    EXECUTE format('ALTER INDEX access.%I RENAME TO %I', row.indexname,
      replace(replace(row.indexname,'name_','alias_'),'alias_history_name','alias_history_alias'));
  END LOOP;
  IF to_regprocedure('access.retain_name_holder()') IS NOT NULL THEN
    ALTER FUNCTION access.retain_name_holder() RENAME TO retain_alias_holder;
  END IF;
  IF to_regprocedure('access.reject_name_history_change()') IS NOT NULL THEN
    ALTER FUNCTION access.reject_name_history_change() RENAME TO reject_alias_history_change;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'access.alias_registry'::regclass
    AND tgname = 'retain_name_holder') THEN
    ALTER TRIGGER retain_name_holder ON access.alias_registry RENAME TO retain_alias_holder;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'access.alias_history'::regclass
    AND tgname = 'immutable_name_history') THEN
    ALTER TRIGGER immutable_name_history ON access.alias_history RENAME TO immutable_alias_history;
  END IF;
END $$;

-- DROP COLUMN removes the former combined key/display SID check. Reinstate
-- the key's half explicitly, without weakening identity-key rejection.
ALTER TABLE access.alias_registry DROP COLUMN IF EXISTS display;
ALTER TABLE access.alias_history DROP COLUMN IF EXISTS display;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'access.alias_registry'::regclass
    AND conname = 'alias_registry_key_identity_check') THEN
    ALTER TABLE access.alias_registry ADD CONSTRAINT alias_registry_key_identity_check
      CHECK (NOT access.has_address_sid_case_variant(key));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION access.retain_alias_holder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.scope <> OLD.scope OR NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'Alias ownership is permanent' USING ERRCODE = '23514';
  END IF;
  IF NEW.holder <> OLD.holder AND NOT (OLD.scope = 'space' AND OLD.state = 'retired'
    AND NEW.controller = OLD.controller AND EXISTS (SELECT 1 FROM access.admission a
      WHERE a.id = OLD.creation_admission AND a.action = 'space.create' AND a.acting_subject = OLD.controller
        AND a.state = 'sealed' AND a.graph_outcome = 'cancelled')) THEN
    RAISE EXCEPTION 'Alias ownership is permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION access.reject_alias_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Alias history is immutable' USING ERRCODE = '23514'; END $$;

-- Retained command results must not leak a second alias spelling on replay.
UPDATE access.alias_receipt SET result = (result - 'display') || '{"profile":"alias-write-v1"}'::jsonb
  WHERE result ? 'display' OR result ->> 'profile' = 'name-write-v1';
