-- Private staging ledger for bulk semantic changes. Staged page bytes are immutable
-- objects and nothing here is native semantic state: activation commits the graph
-- once through the command endpoint and this owner keeps only its certificate.
-- The validation posture is fixed; no request can select warn-only or skip.
CREATE SCHEMA semantic;

CREATE FUNCTION semantic.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable semantic staging record' USING ERRCODE = '23514';
END $$;

CREATE TABLE semantic.change_stage (
  id uuid PRIMARY KEY,
  admission_id uuid NOT NULL UNIQUE,
  principal_id uuid NOT NULL,
  acting_subject text NOT NULL CHECK (acting_subject ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  profile text NOT NULL CHECK (profile = 'semantic-change-bulk-v1'),
  model_generation text NOT NULL CHECK (model_generation ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  validation_posture text NOT NULL DEFAULT 'reject' CHECK (validation_posture = 'reject'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 4096),
  item_count bigint NOT NULL CHECK (item_count BETWEEN 1 AND 10000000),
  byte_count bigint NOT NULL CHECK (byte_count BETWEEN 1 AND 17179869184),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE TRIGGER semantic_change_stage_immutable BEFORE UPDATE OR DELETE ON semantic.change_stage
  FOR EACH ROW EXECUTE FUNCTION semantic.no_mutation();

-- One row per unsettled stage, so recovery scans only open work in creation order.
CREATE TABLE semantic.change_stage_pending (
  stage_id uuid PRIMARY KEY REFERENCES semantic.change_stage(id),
  created_at timestamptz NOT NULL
);
CREATE INDEX semantic_change_stage_pending_order ON semantic.change_stage_pending (created_at, stage_id);

-- A page row exists only after its bytes were stored and read back by digest.
CREATE TABLE semantic.change_stage_page (
  stage_id uuid NOT NULL REFERENCES semantic.change_stage(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4095),
  page_digest text NOT NULL CHECK (page_digest ~ '^[0-9a-f]{64}$'),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 10000),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (stage_id, ordinal)
);
CREATE TRIGGER semantic_change_stage_page_immutable BEFORE UPDATE OR DELETE ON semantic.change_stage_page
  FOR EACH ROW EXECUTE FUNCTION semantic.no_mutation();

-- Validation is recorded per page and model generation. A later generation needs
-- its own complete pass; a report on another generation never carries over.
CREATE TABLE semantic.change_stage_validation (
  stage_id uuid NOT NULL,
  ordinal integer NOT NULL,
  model_generation text NOT NULL CHECK (model_generation ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  outcome text NOT NULL CHECK (outcome IN ('conforming', 'nonconforming', 'unsupported', 'budget-exhausted')),
  report_digest text CHECK (report_digest ~ '^[0-9a-f]{64}$'),
  validated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (stage_id, model_generation, ordinal),
  FOREIGN KEY (stage_id, ordinal) REFERENCES semantic.change_stage_page(stage_id, ordinal),
  CHECK (outcome = 'conforming' OR report_digest IS NOT NULL)
);
CREATE TRIGGER semantic_change_stage_validation_immutable BEFORE UPDATE OR DELETE ON semantic.change_stage_validation
  FOR EACH ROW EXECUTE FUNCTION semantic.no_mutation();

-- The terminal certificate. An activation or a graph-recorded rejection names the
-- existing graph receipt and its source position; nothing here is a second receipt.
CREATE TABLE semantic.change_stage_outcome (
  stage_id uuid PRIMARY KEY REFERENCES semantic.change_stage(id),
  outcome text NOT NULL CHECK (outcome IN ('activated', 'rejected', 'abandoned')),
  reason text CHECK (reason IN ('nonconforming', 'unsupported', 'budget-exhausted',
    'generation-changed', 'stale-head', 'denied', 'abandoned')),
  model_generation text NOT NULL CHECK (model_generation ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  graph_receipt text CHECK (graph_receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  data_epoch uuid,
  sequence numeric(38,0) CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'activated') = (reason IS NULL)),
  CHECK ((outcome = 'abandoned') = (reason = 'abandoned')),
  CHECK (outcome <> 'activated' OR graph_receipt IS NOT NULL),
  CHECK ((graph_receipt IS NULL) = (data_epoch IS NULL) AND (data_epoch IS NULL) = (sequence IS NULL))
);
CREATE TRIGGER semantic_change_stage_outcome_immutable BEFORE UPDATE OR DELETE ON semantic.change_stage_outcome
  FOR EACH ROW EXECUTE FUNCTION semantic.no_mutation();

CREATE FUNCTION semantic.open_change_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO semantic.change_stage_pending (stage_id, created_at) VALUES (NEW.id, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER semantic_change_stage_open AFTER INSERT ON semantic.change_stage
  FOR EACH ROW EXECUTE FUNCTION semantic.open_change_stage();

-- Pages and validations serialize on the pending row; a settled stage accepts neither.
CREATE FUNCTION semantic.check_change_stage_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM semantic.change_stage_pending p JOIN semantic.change_stage s ON s.id = p.stage_id
    WHERE p.stage_id = NEW.stage_id AND NEW.ordinal < s.page_count FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic stage page is outside an open stage'
      USING ERRCODE = '23514', CONSTRAINT = 'semantic_stage_page_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER semantic_change_stage_page_open BEFORE INSERT ON semantic.change_stage_page
  FOR EACH ROW EXECUTE FUNCTION semantic.check_change_stage_page();

CREATE FUNCTION semantic.check_change_stage_validation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM semantic.change_stage_pending WHERE stage_id = NEW.stage_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic stage is settled'
      USING ERRCODE = '23514', CONSTRAINT = 'semantic_stage_validation_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER semantic_change_stage_validation_open BEFORE INSERT ON semantic.change_stage_validation
  FOR EACH ROW EXECUTE FUNCTION semantic.check_change_stage_validation();

-- Activation requires every declared page, each conforming under the activating
-- generation. Settlement removes the pending row in the same transaction.
CREATE FUNCTION semantic.settle_change_stage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pages integer; conforming integer; declared integer;
BEGIN
  SELECT s.page_count INTO declared FROM semantic.change_stage_pending p
    JOIN semantic.change_stage s ON s.id = p.stage_id WHERE p.stage_id = NEW.stage_id FOR UPDATE OF p;
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
  END IF;
  DELETE FROM semantic.change_stage_pending WHERE stage_id = NEW.stage_id;
  RETURN NEW;
END $$;
CREATE TRIGGER semantic_change_stage_settle BEFORE INSERT ON semantic.change_stage_outcome
  FOR EACH ROW EXECUTE FUNCTION semantic.settle_change_stage();
