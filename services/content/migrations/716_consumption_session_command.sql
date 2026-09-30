INSERT INTO content.receipt_action (action) VALUES ('session.create'), ('session.update')
  ON CONFLICT DO NOTHING;
CREATE TABLE reader.consumption_session_command (
  principal_issuer text NOT NULL,
  principal_subject text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  session text NOT NULL REFERENCES reader.consumption_session(id),
  result jsonb NOT NULL,
  content_operation text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_issuer, principal_subject, idempotency_key)
);
CREATE TRIGGER consumption_session_command_immutable BEFORE UPDATE OR DELETE
  ON reader.consumption_session_command FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
