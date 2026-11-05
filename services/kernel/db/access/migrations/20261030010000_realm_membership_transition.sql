-- migrate:up
CREATE TABLE access.realm_membership_transition (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  realm_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  hold_transaction_id uuid NOT NULL,
  legacy boolean NOT NULL DEFAULT false,
  proof_transaction_id uuid,
  outcome text CHECK (outcome IN ('published', 'cancelled')),
  consumed_transaction_id uuid,
  PRIMARY KEY (route, account_id, generation_id),
  UNIQUE (route, account_id, realm_id, operation_id),
  CHECK (route = (get_byte(uuid_send(account_id),10)*256 + get_byte(uuid_send(account_id),11))),
  CHECK ((proof_transaction_id IS NULL) = (outcome IS NULL)),
  CHECK ((proof_transaction_id IS NULL) = (consumed_transaction_id IS NULL))
);
CREATE UNIQUE INDEX realm_membership_transition_open
  ON access.realm_membership_transition (route, account_id, realm_id) WHERE proof_transaction_id IS NULL;
CREATE FUNCTION access.guard_realm_membership_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.proof_transaction_id IS NULL AND NEW.proof_transaction_id IS NOT NULL
    AND NEW.outcome IS NOT NULL AND NEW.consumed_transaction_id IS NOT NULL
    AND (to_jsonb(OLD) - 'proof_transaction_id' - 'outcome' - 'consumed_transaction_id') =
        (to_jsonb(NEW) - 'proof_transaction_id' - 'outcome' - 'consumed_transaction_id')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Realm transition provenance and consumption are immutable' USING ERRCODE = '23514';
END; $$;
CREATE TRIGGER realm_membership_transition_guard BEFORE UPDATE OR DELETE ON access.realm_membership_transition
  FOR EACH ROW EXECUTE FUNCTION access.guard_realm_membership_transition();
CREATE TABLE access.realm_membership_reconciliation (
  route integer NOT NULL, account_id uuid NOT NULL, barrier_id text NOT NULL,
  after_id uuid, completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, account_id, barrier_id)
);
CREATE TABLE access.realm_membership_reconciliation_item (
  route integer NOT NULL, account_id uuid NOT NULL, barrier_id text NOT NULL,
  reservation_id uuid NOT NULL, realm_id uuid NOT NULL, hold_transaction_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('published','cancelled','pending','uncertain')),
  PRIMARY KEY (route, account_id, barrier_id, reservation_id)
);
CREATE INDEX realm_membership_reconciliation_pending ON access.realm_membership_reconciliation_item
 (route, account_id, barrier_id, reservation_id) WHERE state IN ('pending','uncertain');

-- migrate:down
-- Forward-only: immutable transition evidence must survive rollback of a writer.
