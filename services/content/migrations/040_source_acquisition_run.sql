-- A general acquisition run freezes its surfaces at creation and references exact
-- source.observation captures. It is not a second capture store or intake receipt:
-- the run row carries the owner's per-principal idempotency key and the completion
-- row is the run's only completed receipt. No row here withdraws or deletes data.
CREATE TABLE source.acquisition_run (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  profile text NOT NULL CHECK (profile ~ '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}$'),
  surface_count integer NOT NULL CHECK (surface_count BETWEEN 1 AND 32),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX acquisition_run_principal_idx
  ON source.acquisition_run (principal_id, provider, created_at, id);
CREATE TRIGGER source_acquisition_run_immutable BEFORE UPDATE OR DELETE ON source.acquisition_run
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- Provider terms bound retention; a reproduction request cannot widen them (LIVE16).
CREATE TABLE source.acquisition_run_surface (
  run_id uuid NOT NULL REFERENCES source.acquisition_run(id),
  surface text NOT NULL CHECK (surface ~ '^[a-z0-9][a-z0-9._:/-]{0,99}$'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  required boolean NOT NULL,
  capture_limit integer NOT NULL CHECK (capture_limit BETWEEN 1 AND 4096),
  requested_retention text NOT NULL CHECK (requested_retention IN ('retained', 'not-retained')),
  retention_terms text NOT NULL CHECK (retention_terms IN ('permitted', 'prohibited')),
  terms_reference text NOT NULL CHECK (length(terms_reference) BETWEEN 1 AND 500
    AND terms_reference !~ '[[:cntrl:]]'),
  effective_retention text GENERATED ALWAYS AS (CASE WHEN requested_retention = 'retained'
    AND retention_terms = 'permitted' THEN 'retained' ELSE 'not-retained' END) STORED,
  retention_limited boolean GENERATED ALWAYS AS (requested_retention = 'retained'
    AND retention_terms = 'prohibited') STORED,
  PRIMARY KEY (run_id, surface),
  UNIQUE (run_id, ordinal)
);
CREATE TRIGGER source_acquisition_run_surface_immutable
  BEFORE UPDATE OR DELETE ON source.acquisition_run_surface
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- A capture is one immutable observation of one request. The same request is
-- captured once per run and reused by every consumer of that run (LIVE09).
CREATE TABLE source.run_capture (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  surface text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4095),
  role text NOT NULL CHECK (role IN ('response', 'context', 'manifest')),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 1000
    AND request_key !~ '[[:cntrl:]]'),
  observation_id uuid NOT NULL UNIQUE REFERENCES source.observation(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (run_id, surface) REFERENCES source.acquisition_run_surface(run_id, surface),
  UNIQUE (run_id, surface, ordinal),
  UNIQUE (run_id, request_key)
);
CREATE TRIGGER source_run_capture_immutable BEFORE UPDATE OR DELETE ON source.run_capture
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- Every surface ends with exactly one explicit outcome. Unavailable access or a
-- failed fetch is never recorded as an empty qualified surface (LIVE02/LIVE11).
CREATE TABLE source.run_surface_outcome (
  run_id uuid NOT NULL,
  surface text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('qualified', 'unqualified', 'failed')),
  reason text NOT NULL CHECK (reason ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  capture_count integer NOT NULL CHECK (capture_count BETWEEN 0 AND 4096),
  capture_set_digest text CHECK (capture_set_digest ~ '^[0-9a-f]{64}$'),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, surface),
  FOREIGN KEY (run_id, surface) REFERENCES source.acquisition_run_surface(run_id, surface),
  CHECK ((outcome = 'qualified') = (reason = 'complete')),
  CHECK (outcome <> 'qualified' OR capture_count >= 1),
  CHECK ((capture_count = 0) = (capture_set_digest IS NULL))
);
CREATE TRIGGER source_run_surface_outcome_immutable BEFORE UPDATE OR DELETE ON source.run_surface_outcome
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- `completed` exists only when every surface has an outcome and every required
-- surface is qualified. The counts are derived by the owner trigger, not trusted.
CREATE TABLE source.acquisition_run_completion (
  run_id uuid PRIMARY KEY REFERENCES source.acquisition_run(id),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'incomplete', 'abandoned')),
  qualified_count integer NOT NULL CHECK (qualified_count BETWEEN 0 AND 32),
  unqualified_count integer NOT NULL CHECK (unqualified_count BETWEEN 0 AND 32),
  failed_count integer NOT NULL CHECK (failed_count BETWEEN 0 AND 32),
  missing_count integer NOT NULL CHECK (missing_count BETWEEN 0 AND 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER source_acquisition_run_completion_immutable
  BEFORE UPDATE OR DELETE ON source.acquisition_run_completion
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- Later runs and change consumers look up whether an exact source revision is
-- already observed without scanning a record's history.
CREATE INDEX observation_record_revision_idx ON source.observation (record_id, source_revision, id)
  WHERE source_revision IS NOT NULL;

CREATE FUNCTION source.check_acquisition_run_surfaces() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM source.acquisition_run_surface WHERE run_id = NEW.id) <> NEW.surface_count THEN
    RAISE EXCEPTION 'acquisition run surfaces must be frozen with the run'
      USING ERRCODE = '23514', CONSTRAINT = 'acquisition_run_surfaces_frozen';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER source_acquisition_run_surfaces AFTER INSERT ON source.acquisition_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION source.check_acquisition_run_surfaces();

CREATE FUNCTION source.freeze_acquisition_run_surface() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE declared integer;
BEGIN
  SELECT surface_count INTO declared FROM source.acquisition_run WHERE id = NEW.run_id FOR UPDATE;
  IF NOT FOUND OR (SELECT count(*) FROM source.acquisition_run_surface WHERE run_id = NEW.run_id) >= declared
    OR EXISTS (SELECT 1 FROM source.run_capture WHERE run_id = NEW.run_id)
    OR EXISTS (SELECT 1 FROM source.run_surface_outcome WHERE run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'acquisition run surfaces are frozen'
      USING ERRCODE = '23514', CONSTRAINT = 'acquisition_run_surfaces_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_acquisition_run_surface_freeze BEFORE INSERT ON source.acquisition_run_surface
  FOR EACH ROW EXECUTE FUNCTION source.freeze_acquisition_run_surface();

CREATE FUNCTION source.check_run_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE surface_row source.acquisition_run_surface; run_row source.acquisition_run;
BEGIN
  -- Captures and the surface outcome serialize on the surface row, so an outcome
  -- counts exactly the frozen capture set.
  SELECT * INTO surface_row FROM source.acquisition_run_surface
    WHERE run_id = NEW.run_id AND surface = NEW.surface FOR UPDATE;
  SELECT * INTO run_row FROM source.acquisition_run WHERE id = NEW.run_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM source.observation o JOIN source.record r ON r.id = o.record_id
      WHERE o.id = NEW.observation_id AND o.principal_id = run_row.principal_id
        AND r.provider = run_row.provider AND o.retention = surface_row.effective_retention) THEN
    RAISE EXCEPTION 'run capture differs from the run principal, provider or retention'
      USING ERRCODE = '23514', CONSTRAINT = 'run_capture_observation';
  END IF;
  IF EXISTS (SELECT 1 FROM source.run_surface_outcome WHERE run_id = NEW.run_id AND surface = NEW.surface)
    OR EXISTS (SELECT 1 FROM source.acquisition_run_completion WHERE run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'run capture set is frozen'
      USING ERRCODE = '23514', CONSTRAINT = 'run_capture_frozen';
  END IF;
  IF (SELECT count(*) FROM source.run_capture WHERE run_id = NEW.run_id AND surface = NEW.surface)
      >= surface_row.capture_limit THEN
    RAISE EXCEPTION 'run surface capture budget exhausted'
      USING ERRCODE = '23514', CONSTRAINT = 'run_capture_budget';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_run_capture_check BEFORE INSERT ON source.run_capture
  FOR EACH ROW EXECUTE FUNCTION source.check_run_capture();

CREATE FUNCTION source.check_run_surface_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source.acquisition_run_surface
    WHERE run_id = NEW.run_id AND surface = NEW.surface FOR UPDATE;
  IF EXISTS (SELECT 1 FROM source.acquisition_run_completion WHERE run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'acquisition run is terminal'
      USING ERRCODE = '23514', CONSTRAINT = 'run_capture_frozen';
  END IF;
  IF NEW.capture_count <> (SELECT count(*) FROM source.run_capture
      WHERE run_id = NEW.run_id AND surface = NEW.surface) THEN
    RAISE EXCEPTION 'surface outcome differs from its frozen capture set'
      USING ERRCODE = '23514', CONSTRAINT = 'run_surface_outcome_captures';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_run_surface_outcome_check BEFORE INSERT ON source.run_surface_outcome
  FOR EACH ROW EXECUTE FUNCTION source.check_run_surface_outcome();

CREATE FUNCTION source.check_acquisition_run_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE derived text; required_open integer;
BEGIN
  -- Lock the bounded surface set in ordinal order before deriving the terminal outcome.
  PERFORM 1 FROM source.acquisition_run_surface WHERE run_id = NEW.run_id ORDER BY ordinal FOR UPDATE;
  SELECT count(*) FILTER (WHERE o.outcome = 'qualified'),
    count(*) FILTER (WHERE o.outcome = 'unqualified'),
    count(*) FILTER (WHERE o.outcome = 'failed'),
    count(*) FILTER (WHERE o.outcome IS NULL),
    count(*) FILTER (WHERE s.required AND o.outcome IS DISTINCT FROM 'qualified')
  INTO NEW.qualified_count, NEW.unqualified_count, NEW.failed_count, NEW.missing_count, required_open
  FROM source.acquisition_run_surface s
  LEFT JOIN source.run_surface_outcome o ON o.run_id = s.run_id AND o.surface = s.surface
  WHERE s.run_id = NEW.run_id;
  derived := CASE WHEN NEW.missing_count > 0 THEN 'abandoned'
    WHEN required_open > 0 THEN 'incomplete' ELSE 'completed' END;
  IF NEW.outcome <> derived THEN
    RAISE EXCEPTION 'acquisition run outcome differs from its surface outcomes'
      USING ERRCODE = '23514', CONSTRAINT = 'acquisition_run_completion_outcome';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_acquisition_run_completion_check BEFORE INSERT ON source.acquisition_run_completion
  FOR EACH ROW EXECUTE FUNCTION source.check_acquisition_run_completion();
