-- Verification owner (information-verification.md). Content DB placement keeps
-- local FKs to the immutable source.observation evidence it qualifies. Claims,
-- claim revisions and assessment anchors stay Jena-owned (claim-v1, assessment-v1);
-- these rows reference them by exact IRI and never become a second writer.
CREATE SCHEMA IF NOT EXISTS verification;

CREATE DOMAIN verification.rezics_id AS text
  CHECK (VALUE ~ '^https://rezics\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
CREATE DOMAIN verification.iri AS text
  CHECK (length(VALUE) BETWEEN 1 AND 300 AND VALUE ~ '^(https://|urn:)[^[:space:][:cntrl:]<>"{}|\\^`]+$');
CREATE DOMAIN verification.sha256 AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN verification.note AS text
  CHECK (length(VALUE) BETWEEN 1 AND 2000 AND VALUE !~ '[[:cntrl:]]' AND VALUE = btrim(VALUE));

CREATE FUNCTION verification.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable verification record' USING ERRCODE = '23514';
END $$;

-- The owner-local idempotency receipt, as source.intake_receipt and
-- access.grant_change_receipt: one identity per principal, action and key.
-- Domain rows carry the receipt id; retries replay the recorded result.
CREATE TABLE verification.receipt (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('origin.record', 'derivation.record', 'lineage.record',
    'lineage.retract', 'evidence.record', 'challenge.submit', 'challenge.resolve')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest verification.sha256 NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  result_id uuid,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, action, idempotency_key),
  CHECK ((outcome = 'succeeded' AND result_id IS NOT NULL AND reason IS NULL)
    OR (outcome = 'rejected' AND result_id IS NULL AND reason IS NOT NULL))
);
CREATE TRIGGER verification_receipt_immutable BEFORE UPDATE OR DELETE ON verification.receipt
  FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- An identified origin (original publication, dataset or statement) that
-- observations may copy without REZICS having observed the origin itself.
CREATE TABLE verification.origin (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('publication', 'dataset', 'statement', 'native')),
  locator text NOT NULL CHECK (length(locator) BETWEEN 1 AND 1000 AND locator !~ '[[:cntrl:]]'),
  operation_id uuid NOT NULL UNIQUE REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER verification_origin_immutable BEFORE UPDATE OR DELETE ON verification.origin
  FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- A PROV activity that produced an observation or a claim revision: AI/tool
-- method, model, profile and limits stay attached to the exact output.
CREATE TABLE verification.derivation (
  id uuid PRIMARY KEY,
  output_observation_id uuid UNIQUE REFERENCES source.observation(id),
  output_reference verification.iri UNIQUE,
  kind text NOT NULL CHECK (kind IN ('ai-extraction', 'ai-generation', 'tool-extraction',
    'human-transcription', 'syndication-import')),
  method verification.iri NOT NULL,
  model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200),
  tool_version text CHECK (tool_version IS NULL OR length(tool_version) BETWEEN 1 AND 200),
  profile_revision verification.iri,
  limitations verification.note NOT NULL,
  input_count smallint NOT NULL CHECK (input_count BETWEEN 1 AND 32),
  operation_id uuid NOT NULL UNIQUE REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(output_observation_id, output_reference) = 1),
  CHECK (kind NOT LIKE 'ai-%' OR model IS NOT NULL)
);
CREATE TRIGGER verification_derivation_immutable BEFORE UPDATE OR DELETE ON verification.derivation
  FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- The complete input manifest of one activity. For an observation output the
-- dependency walk reads these rows as derived-from edges; they are not copied
-- into lineage_edge, so one derivation fact has one owner row.
CREATE TABLE verification.derivation_input (
  derivation_id uuid NOT NULL REFERENCES verification.derivation(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  input_observation_id uuid REFERENCES source.observation(id),
  input_origin_id uuid REFERENCES verification.origin(id),
  input_reference verification.iri,
  PRIMARY KEY (derivation_id, ordinal),
  CHECK (num_nonnulls(input_observation_id, input_origin_id, input_reference) = 1)
);
CREATE UNIQUE INDEX derivation_input_identity ON verification.derivation_input (derivation_id,
  COALESCE(input_observation_id::text, input_origin_id::text, input_reference));
CREATE INDEX derivation_input_observation ON verification.derivation_input (input_observation_id)
  WHERE input_observation_id IS NOT NULL;
CREATE INDEX derivation_input_origin ON verification.derivation_input (input_origin_id)
  WHERE input_origin_id IS NOT NULL;
CREATE TRIGGER verification_derivation_input_immutable BEFORE UPDATE OR DELETE
  ON verification.derivation_input FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- A manifest is complete at commit: exactly input_count ordered inputs, never
-- extended by a later transaction (an extra row makes the count differ).
CREATE FUNCTION verification.check_derivation_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; expected smallint; actual bigint; highest smallint;
BEGIN
  -- Separate statements: each trigger table plans only its own NEW fields.
  IF TG_TABLE_NAME = 'derivation' THEN target := NEW.id; ELSE target := NEW.derivation_id; END IF;
  SELECT input_count INTO expected FROM verification.derivation WHERE id = target;
  SELECT count(*), max(ordinal) INTO actual, highest
    FROM verification.derivation_input WHERE derivation_id = target;
  IF actual <> expected OR highest <> expected - 1 THEN
    RAISE EXCEPTION 'derivation inputs differ from the complete activity manifest'
      USING ERRCODE = '23514', CONSTRAINT = 'derivation_complete_inputs';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER derivation_complete_inputs AFTER INSERT ON verification.derivation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verification.check_derivation_inputs();
CREATE CONSTRAINT TRIGGER derivation_input_complete AFTER INSERT ON verification.derivation_input
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verification.check_derivation_inputs();

-- Directed dependency edges between observations and origins. Absence of an
-- edge is unknown dependence, never proof of independence. Cycles are retained
-- and reported by the bounded analysis instead of being rejected here.
CREATE TABLE verification.lineage_edge (
  id uuid PRIMARY KEY,
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  relation text NOT NULL CHECK (relation IN ('copy-of', 'quotation-of', 'derived-from', 'publishes-origin')),
  target_observation_id uuid REFERENCES source.observation(id),
  target_origin_id uuid REFERENCES verification.origin(id),
  target_reference verification.iri,
  basis text NOT NULL CHECK (basis IN ('declared-by-source', 'detected', 'reviewer-asserted')),
  method verification.iri,
  operation_id uuid NOT NULL REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(target_observation_id, target_origin_id, target_reference) = 1),
  CHECK (target_observation_id IS DISTINCT FROM observation_id),
  CHECK (relation <> 'publishes-origin' OR target_origin_id IS NOT NULL),
  CHECK (basis = 'declared-by-source' OR method IS NOT NULL)
);
CREATE UNIQUE INDEX lineage_edge_identity ON verification.lineage_edge (observation_id, relation,
  COALESCE(target_observation_id::text, target_origin_id::text, target_reference));
CREATE INDEX lineage_edge_target_observation ON verification.lineage_edge (target_observation_id, id)
  WHERE target_observation_id IS NOT NULL;
CREATE INDEX lineage_edge_target_origin ON verification.lineage_edge (target_origin_id, id)
  WHERE target_origin_id IS NOT NULL;
CREATE INDEX lineage_edge_operation ON verification.lineage_edge (operation_id);
CREATE TRIGGER verification_lineage_edge_immutable BEFORE UPDATE OR DELETE ON verification.lineage_edge
  FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- Retraction appends; the edge and its earlier use remain inspectable.
CREATE TABLE verification.lineage_retraction (
  edge_id uuid PRIMARY KEY REFERENCES verification.lineage_edge(id),
  reason verification.note NOT NULL,
  operation_id uuid NOT NULL UNIQUE REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER verification_lineage_retraction_immutable BEFORE UPDATE OR DELETE
  ON verification.lineage_retraction FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();
