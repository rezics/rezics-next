-- General source support for one native field slot, keyed by slot rather than
-- cloned per field. The Work English title slot (009/010/017/018/021) and Work
-- author credits (019) keep their owner rows; this model serves every other slot.
-- Native values and control epochs stay in the target owner; the source owner
-- keeps immutable intents, native outcome certificates and withdrawals.
CREATE TABLE source.field_support (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  target text NOT NULL CHECK (target ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  slot text NOT NULL CHECK (slot ~ '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}#[A-Za-z0-9:_.-]{1,100}$'
    AND slot <> 'work-metadata-v1#title:en' AND slot !~ '^work-author-credit-v1#'),
  occurrence text CHECK (occurrence ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  context text NOT NULL CHECK (context = 'global' OR context ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  record_id uuid NOT NULL REFERENCES source.record(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One support per source record and slot occurrence; a second source is a second
  -- support, and a provider redirect never re-targets an existing one (LIVE05/LIVE06).
  UNIQUE NULLS NOT DISTINCT (principal_id, target, slot, occurrence, context, record_id)
);
CREATE INDEX field_support_target_idx ON source.field_support (target, slot, context, id);
CREATE INDEX field_support_record_idx ON source.field_support (record_id, principal_id, id);
CREATE TRIGGER source_field_support_immutable BEFORE UPDATE OR DELETE ON source.field_support
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- Each step binds exact source evidence (conversion, declared field, occurrence,
-- value digest) to an expected native basis. `apply` and `return-control` carry the
-- native CAS inputs: content head, control head/epoch and explicit protection head.
CREATE TABLE source.field_support_step (
  id uuid PRIMARY KEY,
  support_id uuid NOT NULL REFERENCES source.field_support(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1000000),
  principal_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('apply', 'attach', 'return-control')),
  conversion_id uuid NOT NULL REFERENCES source.conversion(id),
  mapping_revision text NOT NULL,
  grain text NOT NULL,
  source_field text NOT NULL,
  source_occurrence text CHECK (source_occurrence ~ '^urn:rezics:source-occurrence:[0-9a-f]{64}$'),
  value_digest text NOT NULL CHECK (value_digest ~ '^[0-9a-f]{64}$'),
  expected_head text NOT NULL CHECK (expected_head ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  control_intent jsonb CHECK (jsonb_typeof(control_intent) = 'object'
    AND control_intent ?& ARRAY['contentHead', 'controlHead', 'controlEpoch', 'protectionHead']
    AND control_intent->>'contentHead' = expected_head),
  acting_subject text NOT NULL CHECK (acting_subject ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  authority_proof jsonb NOT NULL CHECK (jsonb_typeof(authority_proof) = 'object'
    AND authority_proof->>'principalId' = principal_id::text
    AND authority_proof->>'actingSubject' = acting_subject),
  native_idempotency_key text UNIQUE CHECK (native_idempotency_key ~ '^source-field-[0-9a-f-]{36}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (mapping_revision, grain, source_field)
    REFERENCES source.field_disposition(mapping_revision, grain, field_key),
  UNIQUE (support_id, ordinal),
  UNIQUE (principal_id, idempotency_key),
  CHECK ((action = 'attach') = (native_idempotency_key IS NULL)),
  CHECK ((action = 'attach') = (control_intent IS NULL))
);
CREATE INDEX field_support_step_conversion_idx ON source.field_support_step (conversion_id, id);
CREATE TRIGGER source_field_support_step_immutable BEFORE UPDATE OR DELETE ON source.field_support_step
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- A step settles only from its original native terminal receipt; a timeout never
-- does. `not-applied` retains the native rejection, e.g. a lost control CAS (LIVE03).
CREATE TABLE source.field_support_outcome (
  step_id uuid PRIMARY KEY REFERENCES source.field_support_step(id),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'attached', 'returned', 'not-applied')),
  native_revision text CHECK (native_revision ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  graph_receipt text CHECK (graph_receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  admission_id uuid,
  data_epoch uuid,
  sequence numeric(38,0) CHECK (sequence >= 0),
  head_guarantee text NOT NULL CHECK (head_guarantee IN ('transaction-guarded', 'verified-before-commit')),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'attached') = (graph_receipt IS NULL)),
  CHECK ((graph_receipt IS NULL) = (admission_id IS NULL)
    AND (graph_receipt IS NULL) = (data_epoch IS NULL) AND (graph_receipt IS NULL) = (sequence IS NULL)),
  CHECK ((outcome = 'not-applied') = (native_revision IS NULL)),
  CHECK ((outcome = 'attached') = (head_guarantee = 'verified-before-commit'))
);
CREATE UNIQUE INDEX field_support_outcome_receipt_idx ON source.field_support_outcome (graph_receipt)
  WHERE graph_receipt IS NOT NULL;
CREATE TRIGGER source_field_support_outcome_immutable BEFORE UPDATE OR DELETE ON source.field_support_outcome
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.field_support_withdrawal (
  id uuid PRIMARY KEY,
  support_id uuid NOT NULL UNIQUE REFERENCES source.field_support(id),
  principal_id uuid NOT NULL,
  expected_step_id uuid REFERENCES source.field_support_step(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]' AND reason = btrim(reason)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE TRIGGER source_field_support_withdrawal_immutable
  BEFORE UPDATE OR DELETE ON source.field_support_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- Mutable lookup aid derived from immutable steps and outcomes. Its row lock
-- serializes reservation, settlement and withdrawal of one support.
CREATE TABLE source.field_support_head (
  support_id uuid PRIMARY KEY REFERENCES source.field_support(id),
  step_count integer NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  settled_step_id uuid UNIQUE REFERENCES source.field_support_step(id),
  pending_step_id uuid UNIQUE REFERENCES source.field_support_step(id)
);
CREATE INDEX field_support_head_pending_idx ON source.field_support_head (pending_step_id)
  WHERE pending_step_id IS NOT NULL;

CREATE FUNCTION source.initialize_field_support() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source.field_support_head (support_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER source_field_support_initialize AFTER INSERT ON source.field_support
  FOR EACH ROW EXECUTE FUNCTION source.initialize_field_support();

CREATE FUNCTION source.reserve_field_support_step() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head source.field_support_head; support source.field_support;
BEGIN
  SELECT h.* INTO head FROM source.field_support_head h JOIN source.field_support s ON s.id = h.support_id
    WHERE h.support_id = NEW.support_id AND s.principal_id = NEW.principal_id FOR UPDATE OF h;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM source.field_support_withdrawal WHERE support_id = NEW.support_id) THEN
    RAISE EXCEPTION 'field support is unavailable or withdrawn'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_active';
  END IF;
  IF head.pending_step_id IS NOT NULL THEN
    RAISE EXCEPTION 'field support outcome needs reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_settled';
  END IF;
  IF NEW.ordinal <> head.step_count + 1 OR (NEW.action = 'return-control' AND head.settled_step_id IS NULL) THEN
    RAISE EXCEPTION 'field support step differs from its predecessor'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_sequence';
  END IF;
  SELECT * INTO support FROM source.field_support WHERE id = NEW.support_id;
  -- Only a field the mapping declares native/lossy for this exact slot, from this
  -- support's own source record, can support it. A redirect cannot re-route it.
  IF NOT EXISTS (SELECT 1 FROM source.conversion c JOIN source.observation o ON o.id = c.observation_id
      JOIN source.field_disposition d ON d.mapping_revision = c.mapping_revision
      WHERE c.id = NEW.conversion_id AND c.principal_id = NEW.principal_id
        AND c.mapping_revision = NEW.mapping_revision AND o.record_id = support.record_id
        AND d.grain = NEW.grain AND d.field_key = NEW.source_field
        AND d.disposition IN ('native', 'lossy') AND d.native_target = support.slot) THEN
    RAISE EXCEPTION 'field support source evidence differs'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_source';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_field_support_step_reserve BEFORE INSERT ON source.field_support_step
  FOR EACH ROW EXECUTE FUNCTION source.reserve_field_support_step();

CREATE FUNCTION source.pend_field_support_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE source.field_support_head SET step_count = NEW.ordinal, pending_step_id = NEW.id
    WHERE support_id = NEW.support_id;
  RETURN NEW;
END $$;
CREATE TRIGGER source_field_support_step_pend AFTER INSERT ON source.field_support_step
  FOR EACH ROW EXECUTE FUNCTION source.pend_field_support_step();

CREATE FUNCTION source.settle_field_support_step() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE step source.field_support_step;
BEGIN
  SELECT * INTO step FROM source.field_support_step WHERE id = NEW.step_id;
  PERFORM 1 FROM source.field_support_head
    WHERE support_id = step.support_id AND pending_step_id = NEW.step_id FOR UPDATE;
  IF NOT FOUND OR NOT ((step.action = 'apply' AND NEW.outcome IN ('applied', 'not-applied'))
      OR (step.action = 'attach' AND NEW.outcome = 'attached')
      OR (step.action = 'return-control' AND NEW.outcome IN ('returned', 'not-applied'))) THEN
    RAISE EXCEPTION 'field support outcome differs from its pending step'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_outcome_pending';
  END IF;
  UPDATE source.field_support_head SET pending_step_id = NULL,
    settled_step_id = CASE WHEN NEW.outcome = 'not-applied' THEN settled_step_id ELSE NEW.step_id END
    WHERE support_id = step.support_id;
  RETURN NEW;
END $$;
CREATE TRIGGER source_field_support_outcome_settle BEFORE INSERT ON source.field_support_outcome
  FOR EACH ROW EXECUTE FUNCTION source.settle_field_support_step();

CREATE FUNCTION source.withdraw_field_support() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head source.field_support_head;
BEGIN
  SELECT h.* INTO head FROM source.field_support_head h JOIN source.field_support s ON s.id = h.support_id
    WHERE h.support_id = NEW.support_id AND s.principal_id = NEW.principal_id FOR UPDATE OF h;
  IF NOT FOUND OR head.settled_step_id IS DISTINCT FROM NEW.expected_step_id THEN
    RAISE EXCEPTION 'field support identity has changed'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_exact';
  END IF;
  IF head.pending_step_id IS NOT NULL THEN
    RAISE EXCEPTION 'field support outcome needs reconciliation before withdrawal'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_settled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_field_support_withdraw BEFORE INSERT ON source.field_support_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.withdraw_field_support();

-- Repeated source children beyond authors/subjects use the same occurrence-qualified
-- correspondence decision (LIVE04); the pair rules and immutability are unchanged.
ALTER TABLE source.child_correspondence DROP CONSTRAINT child_correspondence_field_check;
ALTER TABLE source.child_correspondence ADD CONSTRAINT child_correspondence_field_key
  CHECK (field ~ '^[A-Za-z0-9@$_][A-Za-z0-9@$_.:/#-]{0,199}$');
