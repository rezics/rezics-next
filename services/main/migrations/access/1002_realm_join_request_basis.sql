-- Requests authorize one exact episode/terms basis, independently of the
-- short-lived generic consent owner. Preserve old request/consent audit rows.
ALTER TABLE access.realm_join_request ALTER COLUMN consent DROP NOT NULL;
ALTER TABLE access.realm_join_request ADD CHECK (membership_generation >= 0 AND policy_revision >= 0);
CREATE TABLE access.realm_join_request_basis (
  request_id uuid PRIMARY KEY REFERENCES access.realm_join_request(id),
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  principal_epoch bigint NOT NULL,
  representation_id uuid NOT NULL REFERENCES access.representation(id),
  representation_generation bigint NOT NULL,
  subject_generation bigint NOT NULL,
  terms_revision text NOT NULL CHECK (length(terms_revision) BETWEEN 1 AND 128)
);
INSERT INTO access.realm_join_request_basis
  (request_id,principal_id,principal_epoch,representation_id,representation_generation,subject_generation,terms_revision)
SELECT q.id,c.principal_id,c.principal_epoch,c.representation_id,c.representation_generation,c.member_generation,c.terms_revision
FROM access.realm_join_request q JOIN access.membership_consent c ON c.id = q.consent;
ALTER TABLE access.realm_join_request ADD CONSTRAINT realm_join_request_complete_basis
  FOREIGN KEY (id) REFERENCES access.realm_join_request_basis(request_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER realm_join_request_basis_immutable BEFORE UPDATE OR DELETE
  ON access.realm_join_request_basis FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();
