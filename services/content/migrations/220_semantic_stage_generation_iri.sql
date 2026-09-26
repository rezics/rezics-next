-- Main's exact model generation head is content addressed and therefore an IRI,
-- not a newly allocated native UUID. Staging may only name that representation.
ALTER TABLE semantic.change_stage
  DROP CONSTRAINT change_stage_model_generation_check,
  ADD CONSTRAINT semantic_change_stage_model_generation_iri CHECK (
    model_generation ~ '^urn:rezics:model-generation:[0-9a-f]{64}$'
  );

ALTER TABLE semantic.change_stage_validation
  DROP CONSTRAINT change_stage_validation_model_generation_check,
  ADD CONSTRAINT semantic_change_stage_validation_generation_iri CHECK (
    model_generation ~ '^urn:rezics:model-generation:[0-9a-f]{64}$'
  );

ALTER TABLE semantic.change_stage_outcome
  DROP CONSTRAINT change_stage_outcome_model_generation_check,
  ADD CONSTRAINT semantic_change_stage_outcome_generation_iri CHECK (
    model_generation ~ '^urn:rezics:model-generation:[0-9a-f]{64}$'
  );

CREATE OR REPLACE FUNCTION semantic.settle_change_stage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pages integer; conforming integer; declared integer; staged_generation text;
BEGIN
  SELECT s.page_count, s.model_generation INTO declared, staged_generation
    FROM semantic.change_stage_pending p
    JOIN semantic.change_stage s ON s.id = p.stage_id
    WHERE p.stage_id = NEW.stage_id FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic stage is already settled'
      USING ERRCODE = '23514', CONSTRAINT = 'semantic_stage_settled';
  END IF;
  IF NEW.outcome = 'activated' THEN
    SELECT count(*) INTO pages FROM semantic.change_stage_page WHERE stage_id = NEW.stage_id;
    SELECT count(*) INTO conforming FROM semantic.change_stage_validation
      WHERE stage_id = NEW.stage_id AND model_generation = NEW.model_generation AND outcome = 'conforming';
    IF pages <> declared OR conforming <> declared THEN
      RAISE EXCEPTION 'semantic stage is not completely conforming under the activating generation'
        USING ERRCODE = '23514', CONSTRAINT = 'semantic_stage_conforming';
    END IF;
    IF NEW.model_generation <> staged_generation THEN
      RAISE EXCEPTION 'semantic stage was prepared under a different model generation'
        USING ERRCODE = '23514', CONSTRAINT = 'semantic_stage_generation';
    END IF;
  END IF;
  DELETE FROM semantic.change_stage_pending WHERE stage_id = NEW.stage_id;
  RETURN NEW;
END $$;
