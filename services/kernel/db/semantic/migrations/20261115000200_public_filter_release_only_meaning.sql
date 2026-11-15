-- migrate:up
-- Release-only meaning changes immutable capture/replay identity. Existing derivatives
-- require operator-verified native retirement; this migration never rewrites or deletes them.
LOCK TABLE
  semantic.public_filter_read_definition,
  semantic.public_filter_projection_build,
  semantic.public_filter_projection_replay,
  semantic.public_filter_bootstrap,
  semantic.public_filter_bootstrap_account,
  semantic.public_filter_repair_step,
  semantic.public_filter_repair_advance,
  semantic.public_filter_population_start IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM semantic.public_filter_read_definition LIMIT 1)
    OR EXISTS (SELECT 1 FROM semantic.public_filter_projection_build LIMIT 1)
    OR EXISTS (SELECT 1 FROM semantic.public_filter_projection_replay LIMIT 1)
    OR EXISTS (SELECT 1 FROM semantic.public_filter_bootstrap LIMIT 1)
    OR EXISTS (SELECT 1 FROM semantic.public_filter_bootstrap_account LIMIT 1)
    OR EXISTS (SELECT 1 FROM semantic.public_filter_repair_step LIMIT 1)
    OR EXISTS (SELECT 1 FROM semantic.public_filter_repair_advance LIMIT 1)
    OR EXISTS (SELECT 1 FROM semantic.public_filter_population_start LIMIT 1) THEN
    RAISE EXCEPTION 'Release-only public-filter meaning requires an operator-verified derivative drain'
      USING ERRCODE='23514',
        DETAIL='Retained definitions, projection builds, replay, bootstrap, repair and population rows cannot be converted in place.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION semantic.retain_public_filter_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.partition_no,NEW.read_definition,NEW.source_id,NEW.configuration,NEW.release_digest,
      NEW.capture_digest,NEW.capture,NEW.dependency_keys) IS DISTINCT FROM
     (OLD.partition_no,OLD.read_definition,OLD.source_id,OLD.configuration,OLD.release_digest,
      OLD.capture_digest,OLD.capture,OLD.dependency_keys)
     OR (OLD.coverage_keys IS NOT NULL AND NEW.coverage_keys IS DISTINCT FROM OLD.coverage_keys) THEN
    RAISE EXCEPTION 'Original public-filter definitions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE semantic.public_filter_read_definition
  DROP CONSTRAINT public_filter_read_definition_partition_no_source_id_config_key,
  DROP COLUMN subject_type,
  ADD CONSTRAINT public_filter_read_definition_release_capture_key
    UNIQUE (partition_no,source_id,configuration,release_digest,capture_digest);
ALTER TABLE semantic.public_filter_projection_build DROP COLUMN meaning_type;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Release-only meaning requires a forward migration'; END $$;
