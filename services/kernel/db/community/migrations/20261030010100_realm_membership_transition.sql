-- migrate:up
CREATE TABLE community.realm_membership_proof (
  route integer NOT NULL, realm_id uuid NOT NULL, account_id uuid NOT NULL,
  reservation_id uuid NOT NULL, generation_id uuid NOT NULL, operation_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('published','cancelled')),
  transaction_id uuid NOT NULL, publication_transaction_id uuid,
  principal_id uuid NOT NULL, command_kind text NOT NULL, command_key text NOT NULL,
  at timestamptz NOT NULL CHECK (isfinite(at)),
  PRIMARY KEY (route, realm_id, account_id, generation_id),
  UNIQUE (route, realm_id, account_id, operation_id),
  CHECK (route = (get_byte(uuid_send(realm_id),10)*256 + get_byte(uuid_send(realm_id),11)))
);
CREATE TRIGGER realm_membership_proof_immutable BEFORE UPDATE OR DELETE ON community.realm_membership_proof
 FOR EACH ROW EXECUTE FUNCTION community.guard_realm_member_terminal();

-- migrate:down
-- Forward-only: immutable transition evidence must survive rollback of a writer.
