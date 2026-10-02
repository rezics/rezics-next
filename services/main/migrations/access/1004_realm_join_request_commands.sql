CREATE TABLE access.realm_join_request_command_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL REFERENCES access.realm_join_request(id),
  decision_id uuid NOT NULL REFERENCES access.realm_join_request_decision(id),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id,idempotency_key)
);
CREATE TRIGGER realm_join_request_command_receipt_immutable BEFORE UPDATE OR DELETE
  ON access.realm_join_request_command_receipt FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();
