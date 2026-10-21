-- Independent Source annotation of an already authored, exactly qualified native
-- credit. No conversion/mapping receipt is implied and native identity is unchanged.
CREATE TABLE source.native_credit_annotation (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  slot_digest text NOT NULL CHECK (slot_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  request jsonb NOT NULL CHECK (request->>'profile' = 'source-native-credit-annotation-v1'),
  native_witness jsonb NOT NULL,
  authority jsonb NOT NULL,
  receipt text NOT NULL UNIQUE CHECK (receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id,idempotency_key),
  UNIQUE (principal_id,slot_digest,id)
);
CREATE TABLE source.native_credit_annotation_head (
  principal_id uuid NOT NULL, slot_digest text NOT NULL, head uuid NOT NULL,
  PRIMARY KEY (principal_id,slot_digest),
  FOREIGN KEY (principal_id,slot_digest,head)
    REFERENCES source.native_credit_annotation(principal_id,slot_digest,id)
);
CREATE TABLE source.native_credit_annotation_withdrawal (
  id uuid PRIMARY KEY, annotation_id uuid NOT NULL UNIQUE REFERENCES source.native_credit_annotation(id),
  principal_id uuid NOT NULL, idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  receipt text NOT NULL UNIQUE CHECK (receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE (principal_id,idempotency_key)
);
CREATE TRIGGER native_credit_annotation_immutable BEFORE UPDATE OR DELETE ON source.native_credit_annotation
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
CREATE TRIGGER native_credit_annotation_withdrawal_immutable BEFORE UPDATE OR DELETE ON source.native_credit_annotation_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
CREATE INDEX native_credit_annotation_target_idx ON source.native_credit_annotation
  ((request->'native'->>'credit'),(request->'native'->>'revision'),id);
