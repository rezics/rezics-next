-- The mutable head and pending index are bounded lookup aids. Adoption, intent,
-- application and withdrawal facts remain immutable in their owning tables.
CREATE TABLE source.native_work_support_head (
  binding_id uuid PRIMARY KEY REFERENCES source.native_work_binding(id),
  application_id uuid UNIQUE REFERENCES source.native_work_title_application(id)
);
INSERT INTO source.native_work_support_head (binding_id, application_id)
SELECT b.id, a.id FROM source.native_work_binding b
LEFT JOIN source.native_work_title_application a ON a.work = b.work
  AND a.principal_id = b.principal_id
  AND NOT EXISTS (SELECT 1 FROM source.native_work_title_application successor
    WHERE successor.work = a.work AND successor.principal_id = a.principal_id
      AND successor.expected_head = a.work_revision);

CREATE TABLE source.native_work_title_pending (
  intent_id uuid PRIMARY KEY REFERENCES source.native_work_title_intent(id),
  binding_id uuid NOT NULL REFERENCES source.native_work_binding(id)
);
CREATE INDEX native_work_title_pending_binding_idx
  ON source.native_work_title_pending (binding_id);
INSERT INTO source.native_work_title_pending (intent_id, binding_id)
SELECT i.id, b.id FROM source.native_work_title_intent i
JOIN source.native_work_binding b ON b.work = i.work AND b.principal_id = i.principal_id
WHERE NOT EXISTS (SELECT 1 FROM source.native_work_title_application a WHERE a.intent_id = i.id
  AND a.work = i.work AND a.principal_id = i.principal_id AND a.proposal_id = i.proposal_id
  AND a.expected_head = i.expected_head);

CREATE TABLE source.native_work_support_withdrawal (
  id uuid PRIMARY KEY,
  binding_id uuid NOT NULL UNIQUE REFERENCES source.native_work_binding(id),
  principal_id uuid NOT NULL,
  application_id uuid REFERENCES source.native_work_title_application(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]' AND reason = btrim(reason)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE TRIGGER source_native_work_support_withdrawal_immutable
  BEFORE UPDATE OR DELETE ON source.native_work_support_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.initialize_native_work_support() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source.native_work_support_head (binding_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_work_support_initialize AFTER INSERT ON source.native_work_binding
  FOR EACH ROW EXECUTE FUNCTION source.initialize_native_work_support();

CREATE FUNCTION source.reserve_native_work_title_support() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding uuid;
BEGIN
  SELECT h.binding_id INTO binding FROM source.native_work_support_head h
  JOIN source.native_work_binding b ON b.id = h.binding_id
  WHERE b.work = NEW.work AND b.principal_id = NEW.principal_id FOR UPDATE OF h;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM source.native_work_support_withdrawal w
      WHERE w.binding_id = binding) THEN
    RAISE EXCEPTION 'source support is unavailable or withdrawn'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_support_active';
  END IF;
  INSERT INTO source.native_work_title_pending (intent_id, binding_id) VALUES (NEW.id, binding);
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_work_title_reserve AFTER INSERT ON source.native_work_title_intent
  FOR EACH ROW EXECUTE FUNCTION source.reserve_native_work_title_support();

CREATE FUNCTION source.advance_native_work_title_support() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding uuid; predecessor text;
BEGIN
  SELECT h.binding_id, COALESCE(a.work_revision, b.work_revision) INTO binding, predecessor
  FROM source.native_work_support_head h
  JOIN source.native_work_binding b ON b.id = h.binding_id
  LEFT JOIN source.native_work_title_application a ON a.id = h.application_id
  WHERE b.work = NEW.work AND b.principal_id = NEW.principal_id FOR UPDATE OF h;
  IF NOT FOUND OR NEW.expected_head <> predecessor
    OR EXISTS (SELECT 1 FROM source.native_work_support_withdrawal w WHERE w.binding_id = binding)
    OR NOT EXISTS (SELECT 1 FROM source.native_work_title_pending p
      JOIN source.native_work_title_intent i ON i.id = p.intent_id
      WHERE p.intent_id = NEW.intent_id AND p.binding_id = binding
        AND i.proposal_id = NEW.proposal_id AND i.principal_id = NEW.principal_id
        AND i.work = NEW.work AND i.expected_head = NEW.expected_head) THEN
    RAISE EXCEPTION 'source title application differs from support predecessor or intent'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_support_predecessor';
  END IF;
  UPDATE source.native_work_support_head SET application_id = NEW.id WHERE binding_id = binding;
  DELETE FROM source.native_work_title_pending WHERE intent_id = NEW.intent_id;
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_work_title_advance AFTER INSERT ON source.native_work_title_application
  FOR EACH ROW EXECUTE FUNCTION source.advance_native_work_title_support();

CREATE FUNCTION source.withdraw_native_work_title_support() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE application uuid;
BEGIN
  SELECT h.application_id INTO application FROM source.native_work_support_head h
  JOIN source.native_work_binding b ON b.id = h.binding_id
  WHERE b.id = NEW.binding_id AND b.principal_id = NEW.principal_id FOR UPDATE OF h;
  IF NOT FOUND OR application IS DISTINCT FROM NEW.application_id THEN
    RAISE EXCEPTION 'source support identity has changed'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_support_exact';
  END IF;
  IF EXISTS (SELECT 1 FROM source.native_work_title_pending p WHERE p.binding_id = NEW.binding_id) THEN
    RAISE EXCEPTION 'source title intent needs reconciliation before withdrawal'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_support_settled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_work_support_withdraw BEFORE INSERT ON source.native_work_support_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.withdraw_native_work_title_support();
