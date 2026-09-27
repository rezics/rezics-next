-- Generic field-keyed source support for native child occurrences. The graph owns
-- child identity, immutable revision and retirement; this table owns exact source
-- evidence and the replay certificate. Author credits retain their earlier table.
CREATE TABLE source.native_child_intent (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  work text NOT NULL CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  field_key text NOT NULL CHECK (field_key ~ '^[A-Za-z][A-Za-z0-9:_.-]{0,99}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  proposal_id uuid NOT NULL REFERENCES source.native_work_proposal(id),
  conversion_id uuid NOT NULL REFERENCES source.conversion(id),
  record_id uuid NOT NULL REFERENCES source.record(id),
  occurrence text NOT NULL CHECK (occurrence ~ '^urn:rezics:source-occurrence:[0-9a-f]{64}$'),
  source_ordinal integer NOT NULL CHECK (source_ordinal BETWEEN 0 AND 127),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200 AND source_key !~ '[[:cntrl:]]'),
  native_ordinal integer NOT NULL CHECK (native_ordinal BETWEEN 0 AND 127),
  correspondence_id uuid REFERENCES source.child_correspondence(id),
  base_support_id uuid REFERENCES source.native_child_intent(id),
  child text NOT NULL CHECK (child ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  child_revision text NOT NULL CHECK (child_revision ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  authority_proof jsonb NOT NULL CHECK (jsonb_typeof(authority_proof) = 'object'
    AND authority_proof->>'principalId' = principal_id::text
    AND authority_proof->>'scope' = 'work:edit:' || work
    AND authority_proof->>'action' = 'work.edit'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (work, field_key, record_id, occurrence),
  UNIQUE (child, conversion_id)
);
CREATE INDEX native_child_principal_idx ON source.native_child_intent (principal_id, id);
CREATE TRIGGER source_native_child_intent_immutable BEFORE UPDATE OR DELETE ON source.native_child_intent
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.native_child_application (
  intent_id uuid PRIMARY KEY REFERENCES source.native_child_intent(id),
  graph_receipt text NOT NULL CHECK (graph_receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  admission_id uuid NOT NULL,
  data_epoch uuid NOT NULL,
  sequence numeric(38,0) NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER source_native_child_application_immutable BEFORE UPDATE OR DELETE ON source.native_child_application
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.native_child_withdrawal (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES source.native_child_application(intent_id),
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]' AND reason = btrim(reason)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE TRIGGER source_native_child_withdrawal_immutable BEFORE UPDATE OR DELETE ON source.native_child_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.check_native_child_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM source.native_work_proposal p
      JOIN source.conversion c ON c.id = p.conversion_id
      WHERE p.id = NEW.proposal_id AND p.principal_id = NEW.principal_id
        AND p.record_id = NEW.record_id AND c.id = NEW.conversion_id
        AND c.principal_id = NEW.principal_id) THEN
    RAISE EXCEPTION 'native child source identity differs'
      USING ERRCODE = '23514', CONSTRAINT = 'native_child_source';
  END IF;
  IF NEW.base_support_id IS NOT NULL THEN
    PERFORM 1 FROM source.native_child_intent i
      JOIN source.native_child_application a ON a.intent_id = i.id
      WHERE i.id = NEW.base_support_id AND i.principal_id = NEW.principal_id
        AND i.work = NEW.work AND i.field_key = NEW.field_key
        AND i.child = NEW.child AND i.child_revision = NEW.child_revision
      FOR UPDATE OF i;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM source.native_child_withdrawal
        WHERE intent_id = NEW.base_support_id) THEN
      RAISE EXCEPTION 'native child base support unavailable'
        USING ERRCODE = '23514', CONSTRAINT = 'native_child_base';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_child_reserve BEFORE INSERT ON source.native_child_intent
  FOR EACH ROW EXECUTE FUNCTION source.check_native_child_intent();

CREATE FUNCTION source.check_native_child_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source.native_child_intent WHERE id = NEW.intent_id
    AND principal_id = NEW.principal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'native child support belongs to another principal'
      USING ERRCODE = '23514', CONSTRAINT = 'native_child_owner';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_child_withdraw BEFORE INSERT ON source.native_child_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.check_native_child_withdrawal();
