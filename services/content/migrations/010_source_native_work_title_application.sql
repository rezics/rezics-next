CREATE TABLE source.native_work_title_intent (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES source.native_work_proposal(id),
  principal_id uuid NOT NULL,
  work text NOT NULL CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  expected_head text NOT NULL CHECK (expected_head ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  acting_subject text NOT NULL CHECK (acting_subject ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  confirmed_title text NOT NULL CHECK (length(confirmed_title) BETWEEN 1 AND 200
    AND confirmed_title !~ '[[:cntrl:]]'),
  work_idempotency_key text NOT NULL UNIQUE
    CHECK (work_idempotency_key ~ '^source-title-[0-9a-f-]{36}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (work, proposal_id)
);
CREATE INDEX native_work_title_intent_principal_idx
  ON source.native_work_title_intent (principal_id, id);
CREATE TRIGGER source_native_work_title_intent_immutable
  BEFORE UPDATE OR DELETE ON source.native_work_title_intent
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.native_work_title_application (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES source.native_work_title_intent(id),
  proposal_id uuid NOT NULL REFERENCES source.native_work_proposal(id),
  principal_id uuid NOT NULL,
  work text NOT NULL CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  expected_head text NOT NULL CHECK (expected_head ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  work_revision text NOT NULL UNIQUE CHECK (work_revision ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  graph_receipt text NOT NULL UNIQUE CHECK (graph_receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  admission_id uuid NOT NULL UNIQUE,
  data_epoch uuid NOT NULL,
  sequence numeric(38,0) NOT NULL CHECK (sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX native_work_title_application_work_idx
  ON source.native_work_title_application (work, work_revision);
CREATE TRIGGER source_native_work_title_application_immutable
  BEFORE UPDATE OR DELETE ON source.native_work_title_application
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
