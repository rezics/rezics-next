CREATE TABLE source.native_work_adoption_intent (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL UNIQUE REFERENCES source.native_work_proposal(id),
  principal_id uuid NOT NULL,
  acting_subject text NOT NULL CHECK (acting_subject ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  authority_path text NOT NULL CHECK (authority_path IN ('represented-agent', 'direct-principal')),
  confirmed_title text NOT NULL CHECK (length(confirmed_title) BETWEEN 1 AND 200
    AND confirmed_title !~ '[[:cntrl:]]'),
  title_language text NOT NULL CHECK (title_language = 'en'),
  work_idempotency_key text NOT NULL UNIQUE CHECK (work_idempotency_key ~ '^source-adopt-[0-9a-f-]{36}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX native_work_adoption_intent_principal_idx
  ON source.native_work_adoption_intent (principal_id, id);
CREATE TRIGGER source_native_work_adoption_intent_immutable
  BEFORE UPDATE OR DELETE ON source.native_work_adoption_intent
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.native_work_binding (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES source.native_work_adoption_intent(id),
  proposal_id uuid NOT NULL UNIQUE REFERENCES source.native_work_proposal(id),
  principal_id uuid NOT NULL,
  work text NOT NULL UNIQUE CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  main_version text NOT NULL CHECK (main_version ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  work_revision text NOT NULL CHECK (work_revision ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  main_revision text NOT NULL CHECK (main_revision ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  graph_receipt text NOT NULL UNIQUE CHECK (graph_receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  admission_id uuid NOT NULL UNIQUE,
  data_epoch uuid NOT NULL,
  sequence numeric(38,0) NOT NULL CHECK (sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX native_work_binding_principal_idx ON source.native_work_binding (principal_id, id);
CREATE TRIGGER source_native_work_binding_immutable
  BEFORE UPDATE OR DELETE ON source.native_work_binding
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
