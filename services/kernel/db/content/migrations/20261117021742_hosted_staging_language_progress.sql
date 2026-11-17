-- migrate:up
-- Whole and selected source pages count retained placements with language bindings.
CREATE OR REPLACE FUNCTION content.guard_hosted_publication_staging_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'input_version' - 'input_count' - 'input_frozen_version'
        - 'input_frontier' - 'settled_input_count' - 'candidate_count' - 'duplicate_input_count'
        - 'unknown_input_count' - 'target_observation_count' - 'source_frontier' - 'source_exhausted'
        - 'language_occurrence_count'
        - 'closure_frontier' - 'closure_checked_count' - 'closure_missing_count' - 'failure' - 'sealed_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'input_version' - 'input_count' - 'input_frozen_version'
        - 'input_frontier' - 'settled_input_count' - 'candidate_count' - 'duplicate_input_count'
        - 'unknown_input_count' - 'target_observation_count' - 'source_frontier' - 'source_exhausted'
        - 'language_occurrence_count'
        - 'closure_frontier' - 'closure_checked_count' - 'closure_missing_count' - 'failure' - 'sealed_at') THEN
    RAISE EXCEPTION 'Hosted publication staging binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION content.guard_hosted_publication_staging_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'input_version' - 'input_count' - 'input_frozen_version'
        - 'input_frontier' - 'settled_input_count' - 'candidate_count' - 'duplicate_input_count'
        - 'unknown_input_count' - 'target_observation_count' - 'source_frontier' - 'source_exhausted'
        - 'closure_frontier' - 'closure_checked_count' - 'closure_missing_count' - 'failure' - 'sealed_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'input_version' - 'input_count' - 'input_frozen_version'
        - 'input_frontier' - 'settled_input_count' - 'candidate_count' - 'duplicate_input_count'
        - 'unknown_input_count' - 'target_observation_count' - 'source_frontier' - 'source_exhausted'
        - 'closure_frontier' - 'closure_checked_count' - 'closure_missing_count' - 'failure' - 'sealed_at') THEN
    RAISE EXCEPTION 'Hosted publication staging binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
