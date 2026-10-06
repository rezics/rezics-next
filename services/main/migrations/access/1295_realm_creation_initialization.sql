-- The creation admission already indexes (principal, action, creation key).
-- A committed initialization is immutable, independent of later grant revocation.
CREATE TABLE access.realm_creation_initialization (
  admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
  realm text NOT NULL UNIQUE REFERENCES access.realm_admin_owner_bootstrap(realm),
  creation_digest text NOT NULL CHECK (creation_digest ~ '^[0-9a-f]{64}$'),
  access_revision bigint NOT NULL CHECK (access_revision >= 1)
);
CREATE TRIGGER realm_creation_initialization_immutable BEFORE UPDATE OR DELETE
  ON access.realm_creation_initialization FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();
