-- GOV09/GOV10: one immutable invalidation per committed judgment generation.
-- A badge may coalesce older events only by recording the current generation.
CREATE TABLE access.judgment_outbox (
  id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'judgment.aggregate.invalidated.v1'
    CHECK (kind IN ('judgment.aggregate.invalidated.v1', 'judgment.aggregate.baselined.v1')),
  statement text NOT NULL,
  context_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  receipt_id uuid UNIQUE REFERENCES access.judgment_receipt(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (statement, context_key, generation),
  CHECK ((kind = 'judgment.aggregate.baselined.v1') = (receipt_id IS NULL)),
  FOREIGN KEY (statement, context_key)
    REFERENCES access.judgment_aggregate(statement, context_key)
);
CREATE INDEX judgment_outbox_target ON access.judgment_outbox
  (statement, context_key, generation DESC);
CREATE TRIGGER judgment_outbox_immutable BEFORE UPDATE OR DELETE
  ON access.judgment_outbox FOR EACH ROW
  EXECUTE FUNCTION access.reject_judgment_history_mutation();
CREATE FUNCTION access.check_judgment_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'judgment.aggregate.baselined.v1' THEN
    IF NOT EXISTS (SELECT 1 FROM access.judgment_aggregate a
      WHERE a.statement = NEW.statement AND a.context_key = NEW.context_key
        AND a.generation = NEW.generation) THEN
      RAISE EXCEPTION 'judgment baseline differs from aggregate generation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM access.judgment_receipt r
    JOIN access.judgment_aggregate a ON a.statement = NEW.statement
      AND a.context_key = NEW.context_key
    WHERE r.id = NEW.receipt_id AND r.statement = NEW.statement
      AND r.context_key = NEW.context_key AND a.generation = NEW.generation
  ) THEN
    RAISE EXCEPTION 'judgment invalidation must bind its receipt and aggregate generation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER judgment_outbox_exact BEFORE INSERT ON access.judgment_outbox
  FOR EACH ROW EXECUTE FUNCTION access.check_judgment_outbox();
CREATE FUNCTION access.require_judgment_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.judgment_outbox o WHERE o.receipt_id = NEW.id) THEN
    RAISE EXCEPTION 'judgment receipt requires one invalidation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER judgment_receipt_outbox_bound
  AFTER INSERT ON access.judgment_receipt DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION access.require_judgment_outbox();

-- Migration 230 could already have accepted judgments. Its current aggregate
-- is a complete snapshot; one baseline event anchors it without inventing
-- per-write event order from timestamps. Every later write emits its own event.
INSERT INTO access.judgment_outbox (id, kind, statement, context_key, generation)
SELECT md5('judgment-baseline-v1|' || statement || '|' || context_key || '|'
  || generation::text)::uuid, 'judgment.aggregate.baselined.v1',
  statement, context_key, generation
FROM access.judgment_aggregate WHERE generation > 0;

-- A curator declares a concept hint in the same Global/Realm population scope
-- as the judgment. Generation zero is an unconfigured head, never a declaration.
CREATE TABLE access.judgment_concept_hint (
  concept text NOT NULL CHECK (concept ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  context_key text NOT NULL CHECK (context_key = 'global'
    OR context_key ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  hint text CHECK (hint IN ('not-spoiler', 'minor', 'major')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  declared_by_principal uuid REFERENCES access.principal(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (concept, context_key),
  CHECK ((generation = 0 AND hint IS NULL AND declared_by_principal IS NULL)
    OR (generation > 0 AND hint IS NOT NULL AND declared_by_principal IS NOT NULL))
);
CREATE FUNCTION access.advance_judgment_concept_hint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.concept IS DISTINCT FROM OLD.concept
    OR NEW.context_key IS DISTINCT FROM OLD.context_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'concept hint head must advance one generation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER judgment_concept_hint_advance BEFORE UPDATE OR DELETE
  ON access.judgment_concept_hint FOR EACH ROW
  EXECUTE FUNCTION access.advance_judgment_concept_hint();
CREATE TABLE access.judgment_concept_hint_receipt (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  concept text NOT NULL,
  context_key text NOT NULL,
  hint text NOT NULL CHECK (hint IN ('not-spoiler', 'minor', 'major')),
  generation bigint NOT NULL CHECK (generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (concept, context_key, generation),
  FOREIGN KEY (concept, context_key)
    REFERENCES access.judgment_concept_hint(concept, context_key)
);
CREATE TRIGGER judgment_concept_hint_receipt_immutable BEFORE UPDATE OR DELETE
  ON access.judgment_concept_hint_receipt FOR EACH ROW
  EXECUTE FUNCTION access.reject_judgment_history_mutation();

CREATE TABLE access.judgment_badge_projection (
  statement text NOT NULL CHECK (statement ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  context_key text NOT NULL CHECK (context_key = 'global'
    OR context_key ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  source_event uuid REFERENCES access.judgment_outbox(id),
  generation bigint NOT NULL CHECK (generation >= 0),
  concept text,
  hint_generation bigint NOT NULL CHECK (hint_generation >= 0),
  policy_generation text NOT NULL CHECK (policy_generation = 'wilson-v1'),
  protection text NOT NULL CHECK (protection IN ('hide-major', 'hide-any', 'show-all')),
  status text NOT NULL CHECK (status IN ('unknown', 'major', 'minor', 'not-spoiler', 'disputed')),
  sample_size bigint NOT NULL CHECK (sample_size >= 0),
  distribution jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (statement, context_key),
  CHECK ((generation = 0) = (source_event IS NULL))
);
