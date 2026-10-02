-- A request is recipient consent awaiting the existing manager add command.
-- It conveys no membership or read authority by itself.
CREATE TABLE access.realm_join_request (
  id uuid PRIMARY KEY,
  realm text NOT NULL REFERENCES access.realm_admin_revision(realm),
  member text NOT NULL REFERENCES access.authority_subject(id),
  consent uuid NOT NULL REFERENCES access.membership_consent(id),
  membership_generation bigint NOT NULL,
  policy_revision bigint NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX realm_join_request_page ON access.realm_join_request(realm,id);
CREATE TABLE access.realm_join_request_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  request_id uuid NOT NULL REFERENCES access.realm_join_request(id),
  PRIMARY KEY (principal_id,idempotency_key)
);
CREATE TRIGGER realm_join_request_immutable BEFORE UPDATE OR DELETE
  ON access.realm_join_request FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER realm_join_request_receipt_immutable BEFORE UPDATE OR DELETE
  ON access.realm_join_request_receipt FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();
