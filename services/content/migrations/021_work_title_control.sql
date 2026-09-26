-- Legacy rows retain their meaning. New title intents bind the complete native CAS.
ALTER TABLE source.native_work_title_intent ADD COLUMN control_intent jsonb;
ALTER TABLE source.native_work_title_intent ADD CONSTRAINT title_control_intent_object
  CHECK (control_intent IS NULL OR jsonb_typeof(control_intent) = 'object');

CREATE TABLE source.native_work_title_return_intent (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  binding_id uuid NOT NULL REFERENCES source.native_work_binding(id),
  proposal_id uuid NOT NULL REFERENCES source.native_work_proposal(id),
  work text NOT NULL,
  acting_subject text NOT NULL,
  idempotency_key text NOT NULL,
  control_intent jsonb NOT NULL CHECK (jsonb_typeof(control_intent) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE TRIGGER native_work_title_return_immutable BEFORE UPDATE OR DELETE ON source.native_work_title_return_intent
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
CREATE TABLE source.native_work_title_return_pending (
  intent_id uuid PRIMARY KEY REFERENCES source.native_work_title_return_intent(id),
  binding_id uuid NOT NULL REFERENCES source.native_work_binding(id)
);
CREATE INDEX native_work_title_return_pending_binding ON source.native_work_title_return_pending(binding_id);
CREATE TABLE source.native_work_title_return_outcome (
  intent_id uuid PRIMARY KEY REFERENCES source.native_work_title_return_intent(id),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object')
);
CREATE TRIGGER native_work_title_return_outcome_immutable BEFORE UPDATE OR DELETE ON source.native_work_title_return_outcome
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.reserve_native_work_title_return() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source.native_work_support_head h JOIN source.native_work_binding b ON b.id = h.binding_id
    WHERE h.binding_id = NEW.binding_id AND b.work = NEW.work AND b.principal_id = NEW.principal_id FOR UPDATE OF h;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM source.native_work_support_withdrawal WHERE binding_id = NEW.binding_id) THEN
    RAISE EXCEPTION 'source support unavailable' USING ERRCODE = '23514', CONSTRAINT = 'native_work_support_active';
  END IF;
  INSERT INTO source.native_work_title_return_pending VALUES (NEW.id, NEW.binding_id);
  RETURN NEW;
END $$;
CREATE TRIGGER native_work_title_return_reserve AFTER INSERT ON source.native_work_title_return_intent
  FOR EACH ROW EXECUTE FUNCTION source.reserve_native_work_title_return();
CREATE FUNCTION source.settle_native_work_title_return() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source.native_work_support_head h JOIN source.native_work_title_return_intent i ON i.binding_id = h.binding_id
    WHERE i.id = NEW.intent_id FOR UPDATE OF h;
  DELETE FROM source.native_work_title_return_pending WHERE intent_id = NEW.intent_id;
  RETURN NEW;
END $$;
CREATE TRIGGER native_work_title_return_settle AFTER INSERT ON source.native_work_title_return_outcome
  FOR EACH ROW EXECUTE FUNCTION source.settle_native_work_title_return();

CREATE OR REPLACE FUNCTION source.withdraw_native_work_title_support() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE application uuid;
BEGIN
  SELECT h.application_id INTO application FROM source.native_work_support_head h
  JOIN source.native_work_binding b ON b.id = h.binding_id
  WHERE b.id = NEW.binding_id AND b.principal_id = NEW.principal_id FOR UPDATE OF h;
  IF NOT FOUND OR application IS DISTINCT FROM NEW.application_id THEN
    RAISE EXCEPTION 'source support identity has changed' USING ERRCODE = '23514', CONSTRAINT = 'native_work_support_exact';
  END IF;
  IF EXISTS (SELECT 1 FROM source.native_work_title_pending WHERE binding_id = NEW.binding_id)
    OR EXISTS (SELECT 1 FROM source.native_work_title_return_pending WHERE binding_id = NEW.binding_id) THEN
    RAISE EXCEPTION 'source title outcome needs reconciliation' USING ERRCODE = '23514', CONSTRAINT = 'native_work_support_settled';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION source.advance_native_work_title_support() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding uuid; predecessor text; controlled boolean; support_found boolean;
BEGIN
  SELECT h.binding_id, COALESCE(a.work_revision, b.work_revision) INTO binding, predecessor
  FROM source.native_work_support_head h JOIN source.native_work_binding b ON b.id = h.binding_id
  LEFT JOIN source.native_work_title_application a ON a.id = h.application_id
  WHERE b.work = NEW.work AND b.principal_id = NEW.principal_id FOR UPDATE OF h;
  support_found := FOUND;
  SELECT control_intent IS NOT NULL INTO controlled FROM source.native_work_title_intent WHERE id = NEW.intent_id;
  -- The controlled profile's native content/control CAS permits an explicitly
  -- returned human head. Legacy certificates retain their old predecessor rule.
  IF NOT support_found OR controlled IS NULL OR (NOT controlled AND NEW.expected_head <> predecessor)
    OR EXISTS (SELECT 1 FROM source.native_work_support_withdrawal WHERE binding_id = binding)
    OR NOT EXISTS (SELECT 1 FROM source.native_work_title_pending p JOIN source.native_work_title_intent i ON i.id = p.intent_id
      WHERE p.intent_id = NEW.intent_id AND p.binding_id = binding AND i.proposal_id = NEW.proposal_id
        AND i.principal_id = NEW.principal_id AND i.work = NEW.work AND i.expected_head = NEW.expected_head) THEN
    RAISE EXCEPTION 'title certificate differs from reserved intent' USING ERRCODE = '23514', CONSTRAINT = 'native_work_support_predecessor';
  END IF;
  UPDATE source.native_work_support_head SET application_id = NEW.id WHERE binding_id = binding;
  DELETE FROM source.native_work_title_pending WHERE intent_id = NEW.intent_id;
  RETURN NEW;
END $$;
