-- QualitySummary generations: a rebuildable projection keyed by target and
-- context. Each generation pins its exact assessment, policy and dependency
-- heads; one head row per (target, context) activates generations by CAS.
-- Reads prove freshness by rereading the pinned owner heads, so queue lag
-- cannot make an older generation appear current.
CREATE TABLE verification.summary_generation (
  id uuid PRIMARY KEY,
  target verification.iri NOT NULL,
  context verification.iri NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  predecessor uuid,
  claim verification.rezics_id NOT NULL,
  claim_revision verification.rezics_id NOT NULL,
  adopted_revision verification.iri,
  assessment verification.rezics_id,
  policy_revision verification.iri NOT NULL,
  support text NOT NULL CHECK (support IN ('supported', 'contradicted', 'material-conflict',
    'insufficient', 'unknown', 'abstained')),
  review text NOT NULL CHECK (review IN ('unreviewed', 'reviewed')),
  dispute text NOT NULL CHECK (dispute IN ('none', 'challenge-pending', 'disputed', 'resolved')),
  coverage text NOT NULL CHECK (coverage IN ('complete', 'partial', 'incomplete')),
  dependence text NOT NULL CHECK (dependence IN ('established', 'unknown', 'circular', 'over-budget')),
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) BETWEEN 1 AND 16
    AND array_position(reason_codes, NULL) IS NULL),
  dependency_count smallint NOT NULL CHECK (dependency_count BETWEEN 1 AND 80),
  dependency_digest verification.sha256 NOT NULL,
  owner_positions jsonb NOT NULL CHECK (jsonb_typeof(owner_positions) = 'object'
    AND octet_length(owner_positions::text) <= 2048),
  operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9:_./-]{1,200}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (target, context, generation),
  UNIQUE (target, context, id),
  CHECK ((generation = 1) = (predecessor IS NULL)),
  CHECK (assessment IS NOT NULL OR support IN ('unknown', 'abstained')),
  FOREIGN KEY (target, context, predecessor) REFERENCES verification.summary_generation(target, context, id)
);
CREATE TRIGGER verification_summary_generation_immutable BEFORE UPDATE OR DELETE
  ON verification.summary_generation FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- The complete dependency manifest. expected_head NULL is an explicit absent
-- head (for example, no evidence or challenge head yet), not an unknown one.
CREATE TABLE verification.summary_dependency (
  generation_id uuid NOT NULL REFERENCES verification.summary_generation(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 79),
  owner text NOT NULL CHECK (owner IN ('graph', 'content')),
  kind text NOT NULL CHECK (kind IN ('claim', 'evidence-set', 'source-assessment', 'source-observation',
    'source-disposition', 'challenge', 'policy', 'rule', 'acceptance', 'adopted-revision')),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 300),
  expected_head text CHECK (expected_head IS NULL OR length(expected_head) BETWEEN 1 AND 300),
  PRIMARY KEY (generation_id, ordinal),
  UNIQUE (generation_id, kind, reference)
);
CREATE TRIGGER verification_summary_dependency_immutable BEFORE UPDATE OR DELETE
  ON verification.summary_dependency FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

CREATE TABLE verification.summary_head (
  target verification.iri NOT NULL,
  context verification.iri NOT NULL,
  active_generation uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (target, context),
  FOREIGN KEY (target, context, active_generation)
    REFERENCES verification.summary_generation(target, context, id)
);

-- Reverse dependency index over active generations only. The activation
-- trigger replaces it atomically, so fan-out never scans historical manifests.
CREATE TABLE verification.active_dependency (
  kind text NOT NULL,
  reference text NOT NULL,
  target verification.iri NOT NULL,
  context verification.iri NOT NULL,
  generation_id uuid NOT NULL REFERENCES verification.summary_generation(id),
  expected_head text,
  PRIMARY KEY (kind, reference, target, context),
  FOREIGN KEY (target, context) REFERENCES verification.summary_head(target, context)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX active_dependency_summary ON verification.active_dependency (target, context);
CREATE INDEX active_dependency_generation ON verification.active_dependency (generation_id);

-- Only the exact successor of the active generation may activate. A stale
-- worker's generation names an older predecessor and is refused even if its
-- caller forgot the CAS predicate.
CREATE FUNCTION verification.activate_summary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_generation bigint; next_predecessor uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'summary head cannot return to absence' USING ERRCODE = '23514';
  END IF;
  SELECT generation, predecessor INTO next_generation, next_predecessor
    FROM verification.summary_generation WHERE id = NEW.active_generation;
  IF NEW.generation <> next_generation
    OR (TG_OP = 'INSERT' AND next_predecessor IS NOT NULL)
    OR (TG_OP = 'UPDATE' AND ((NEW.target, NEW.context) <> (OLD.target, OLD.context)
      OR next_predecessor IS DISTINCT FROM OLD.active_generation)) THEN
    RAISE EXCEPTION 'summary activation differs from the active generation'
      USING ERRCODE = '23514', CONSTRAINT = 'summary_head_exact_successor';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER summary_head_transition BEFORE INSERT OR UPDATE OR DELETE ON verification.summary_head
  FOR EACH ROW EXECUTE FUNCTION verification.activate_summary();

CREATE FUNCTION verification.replace_active_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM verification.active_dependency WHERE target = NEW.target AND context = NEW.context;
  INSERT INTO verification.active_dependency (kind, reference, target, context, generation_id, expected_head)
    SELECT d.kind, d.reference, NEW.target, NEW.context, d.generation_id, d.expected_head
    FROM verification.summary_dependency d WHERE d.generation_id = NEW.active_generation;
  RETURN NULL;
END $$;
CREATE TRIGGER summary_head_dependencies AFTER INSERT OR UPDATE OF active_generation
  ON verification.summary_head FOR EACH ROW EXECUTE FUNCTION verification.replace_active_dependencies();

-- A generation commits with its complete manifest and is active or superseded.
CREATE FUNCTION verification.check_summary_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; expected smallint; summary_target text; summary_context text;
  actual bigint; highest smallint; indexed bigint;
BEGIN
  IF TG_TABLE_NAME = 'summary_generation' THEN target_id := NEW.id; ELSE target_id := NEW.generation_id; END IF;
  SELECT dependency_count, target, context INTO expected, summary_target, summary_context
    FROM verification.summary_generation WHERE id = target_id;
  SELECT count(*), max(ordinal) INTO actual, highest
    FROM verification.summary_dependency WHERE generation_id = target_id;
  IF actual <> expected OR highest <> expected - 1 THEN
    RAISE EXCEPTION 'summary dependencies differ from the complete manifest'
      USING ERRCODE = '23514', CONSTRAINT = 'summary_complete_manifest';
  END IF;
  IF TG_TABLE_NAME = 'summary_generation' THEN
    IF NOT EXISTS (SELECT 1 FROM verification.summary_head
        WHERE target = summary_target AND context = summary_context AND active_generation = target_id)
      AND NOT EXISTS (SELECT 1 FROM verification.summary_generation WHERE predecessor = target_id) THEN
      RAISE EXCEPTION 'summary generation was not activated'
        USING ERRCODE = '23514', CONSTRAINT = 'summary_generation_activated';
    END IF;
    -- The reverse index matches the active manifest even when dependencies
    -- were inserted after the head moved within the same transaction.
    SELECT count(*) INTO indexed FROM verification.active_dependency WHERE generation_id = target_id;
    IF EXISTS (SELECT 1 FROM verification.summary_head
        WHERE target = summary_target AND context = summary_context AND active_generation = target_id)
      AND indexed <> expected THEN
      RAISE EXCEPTION 'active dependency index differs from the active manifest'
        USING ERRCODE = '23514', CONSTRAINT = 'summary_active_index';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER summary_generation_complete AFTER INSERT ON verification.summary_generation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verification.check_summary_generation();
CREATE CONSTRAINT TRIGGER summary_dependency_complete AFTER INSERT ON verification.summary_dependency
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verification.check_summary_generation();

-- Durable invalidation work. One producer event identity has one row and one
-- effect; fan-out pages resume from a keyset cursor over active_dependency.
CREATE TABLE verification.invalidation (
  id uuid PRIMARY KEY,
  producer text NOT NULL CHECK (producer IN ('graph', 'content')),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 300),
  kind text NOT NULL CHECK (kind IN ('claim', 'evidence-set', 'source-assessment', 'source-observation',
    'source-disposition', 'challenge', 'policy', 'rule', 'acceptance', 'adopted-revision')),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 300),
  changed_head text CHECK (changed_head IS NULL OR length(changed_head) BETWEEN 1 AND 300),
  producer_epoch text CHECK (producer_epoch IS NULL OR length(producer_epoch) BETWEEN 1 AND 100),
  producer_sequence numeric CHECK (producer_sequence IS NULL OR producer_sequence > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete')),
  cursor_target text,
  cursor_context text,
  marked bigint NOT NULL DEFAULT 0 CHECK (marked >= 0),
  pages integer NOT NULL DEFAULT 0 CHECK (pages >= 0),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (producer, event_key),
  CHECK ((producer_epoch IS NULL) = (producer_sequence IS NULL)),
  CHECK ((cursor_target IS NULL) = (cursor_context IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'complete') = (completed_at IS NOT NULL)),
  CHECK (state = 'pending' OR lease_owner IS NULL)
);
CREATE INDEX invalidation_pending ON verification.invalidation (created_at, id) WHERE state = 'pending';
CREATE INDEX invalidation_dependency ON verification.invalidation (kind, reference, created_at);

CREATE FUNCTION verification.guard_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invalidation work is retained' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.producer, NEW.event_key, NEW.kind, NEW.reference, NEW.changed_head,
      NEW.producer_epoch, NEW.producer_sequence, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.producer, OLD.event_key, OLD.kind, OLD.reference, OLD.changed_head,
      OLD.producer_epoch, OLD.producer_sequence, OLD.created_at)
    OR OLD.state = 'complete' OR NEW.marked < OLD.marked OR NEW.pages < OLD.pages
    OR (OLD.cursor_target IS NOT NULL AND (NEW.cursor_target IS NULL
      OR (NEW.cursor_target, NEW.cursor_context) < (OLD.cursor_target, OLD.cursor_context))) THEN
    RAISE EXCEPTION 'invalidation work may only advance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invalidation_monotone BEFORE UPDATE OR DELETE ON verification.invalidation
  FOR EACH ROW EXECUTE FUNCTION verification.guard_invalidation();

-- Deduplicated reassessment demand: one row per summary however many
-- invalidations reach it. A worker completes it only if latest_invalidation
-- is unchanged, so a mark raised during its build is never lost.
CREATE TABLE verification.reassessment_request (
  target verification.iri NOT NULL,
  context verification.iri NOT NULL,
  first_invalidation uuid NOT NULL REFERENCES verification.invalidation(id),
  latest_invalidation uuid NOT NULL REFERENCES verification.invalidation(id),
  marks bigint NOT NULL DEFAULT 1 CHECK (marks > 0),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (target, context),
  FOREIGN KEY (target, context) REFERENCES verification.summary_head(target, context),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX reassessment_queue ON verification.reassessment_request (created_at, target, context);
CREATE INDEX reassessment_first_invalidation ON verification.reassessment_request (first_invalidation);
CREATE INDEX reassessment_latest_invalidation ON verification.reassessment_request (latest_invalidation);
