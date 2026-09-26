-- Native credit/revision state belongs only to Jena. These immutable rows retain
-- the private source command, reserved occurrence and completion certificate.
CREATE TABLE source.author_credit_intent (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  work text NOT NULL CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  proposal_id uuid NOT NULL REFERENCES source.native_work_proposal(id),
  conversion_id uuid NOT NULL REFERENCES source.conversion(id),
  record_id uuid NOT NULL REFERENCES source.record(id),
  occurrence text NOT NULL CHECK (occurrence ~ '^urn:rezics:source-occurrence:[0-9a-f]{64}$'),
  source_ordinal integer NOT NULL CHECK (source_ordinal BETWEEN 0 AND 127),
  source_key text NOT NULL CHECK (source_key ~ '^/authors/OL[1-9][0-9]{0,11}A$'),
  source_role_key text CHECK (length(source_role_key) <= 200),
  correspondence_id uuid REFERENCES source.child_correspondence(id),
  base_support_id uuid REFERENCES source.author_credit_intent(id),
  credit text NOT NULL CHECK (credit ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  credit_revision text NOT NULL CHECK (credit_revision ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  authority_proof jsonb NOT NULL CHECK (jsonb_typeof(authority_proof) = 'object'
    AND authority_proof->>'principalId' = principal_id::text
    AND authority_proof->>'scope' = 'work:edit:' || work
    AND authority_proof->>'action' = 'work.edit'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (work, record_id, occurrence),
  UNIQUE (credit, conversion_id)
);
CREATE TRIGGER source_author_credit_intent_immutable BEFORE UPDATE OR DELETE ON source.author_credit_intent
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.author_credit_application (
  intent_id uuid PRIMARY KEY REFERENCES source.author_credit_intent(id),
  graph_receipt text NOT NULL CHECK (graph_receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  admission_id uuid NOT NULL,
  data_epoch uuid NOT NULL,
  sequence numeric(38,0) NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER source_author_credit_application_immutable BEFORE UPDATE OR DELETE ON source.author_credit_application
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.author_credit_withdrawal (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES source.author_credit_application(intent_id),
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]' AND reason = btrim(reason)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE TRIGGER source_author_credit_withdrawal_immutable BEFORE UPDATE OR DELETE ON source.author_credit_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.check_author_credit_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM source.native_work_proposal p JOIN source.conversion c ON c.id = p.conversion_id
      WHERE p.id = NEW.proposal_id AND p.principal_id = NEW.principal_id
        AND p.record_id = NEW.record_id AND c.id = NEW.conversion_id AND c.principal_id = NEW.principal_id) THEN
    RAISE EXCEPTION 'author credit source identity differs'
      USING ERRCODE = '23514', CONSTRAINT = 'author_credit_source';
  END IF;
  IF NEW.base_support_id IS NOT NULL THEN
    PERFORM 1 FROM source.author_credit_intent i JOIN source.author_credit_application a ON a.intent_id = i.id
      WHERE i.id = NEW.base_support_id AND i.principal_id = NEW.principal_id
        AND i.work = NEW.work AND i.credit = NEW.credit AND i.credit_revision = NEW.credit_revision
      FOR UPDATE OF i;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM source.author_credit_withdrawal WHERE intent_id = NEW.base_support_id) THEN
      RAISE EXCEPTION 'author credit base support unavailable'
        USING ERRCODE = '23514', CONSTRAINT = 'author_credit_base';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_author_credit_reserve BEFORE INSERT ON source.author_credit_intent
  FOR EACH ROW EXECUTE FUNCTION source.check_author_credit_intent();

CREATE FUNCTION source.check_author_credit_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source.author_credit_intent WHERE id = NEW.intent_id AND principal_id = NEW.principal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'author credit support belongs to another principal'
      USING ERRCODE = '23514', CONSTRAINT = 'author_credit_owner';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_author_credit_withdraw BEFORE INSERT ON source.author_credit_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.check_author_credit_withdrawal();
