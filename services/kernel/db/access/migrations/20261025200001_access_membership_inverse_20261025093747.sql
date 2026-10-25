-- migrate:up
-- The version follows the existing migration sequence; the filename suffix is
-- the UTC creation stamp (historical versions already extend past that time).
-- Deployment barrier: stop every old membership writer before this migration.
-- Existing actors remain unreadable until a dedicated coordinator has replayed
-- authoritative membership changes through a stable source cursor, reconciled
-- pending reservations, and certified coverage on each actor anchor. An empty
-- inverse is never evidence of coverage. Do not run mixed-version writers.
ALTER TABLE access.account ADD COLUMN membership_inverse_complete boolean NOT NULL DEFAULT false;

CREATE FUNCTION access.initialize_membership_inverse() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Accounts born after the writer barrier have no historical memberships.
  NEW.membership_inverse_complete := true;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_membership_inverse BEFORE INSERT ON access.account
FOR EACH ROW EXECUTE FUNCTION access.initialize_membership_inverse();

CREATE TABLE access.membership_inverse (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('organization', 'realm')),
  group_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  source_transaction_id uuid,
  PRIMARY KEY (route, account_id, kind, group_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- Durable local compensation provenance. The service writes this only after an
-- independent exact read of an immutable authoritative terminal slot. No expiry,
-- caller assertion or absence proof can stand in for proof_transaction_id.
CREATE TABLE access.membership_inverse_terminal (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('organization', 'realm')),
  group_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  reservation_transaction_id uuid NOT NULL,
  proof_transaction_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, kind, group_id, reservation_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

CREATE FUNCTION access.guard_membership_inverse() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM access.membership_inverse_terminal t
    WHERE t.route = OLD.route AND t.account_id = OLD.account_id
      AND t.kind = OLD.kind AND t.group_id = OLD.group_id
      AND t.reservation_id = OLD.reservation_id
      AND t.reservation_transaction_id = OLD.transaction_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Membership inverse requires verified terminal compensation' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER membership_inverse_guard BEFORE UPDATE OR DELETE ON access.membership_inverse
FOR EACH ROW EXECUTE FUNCTION access.guard_membership_inverse();

CREATE FUNCTION access.guard_membership_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Membership terminal proof is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER membership_inverse_terminal_guard BEFORE UPDATE OR DELETE ON access.membership_inverse_terminal
FOR EACH ROW EXECUTE FUNCTION access.guard_membership_terminal();
CREATE TRIGGER lifecycle_membership_terminal_guard BEFORE UPDATE OR DELETE ON access.lifecycle_membership_slot
FOR EACH ROW WHEN (OLD.terminal) EXECUTE FUNCTION access.guard_membership_terminal();

-- One live reservation per logical membership, irrespective of role evidence.
-- Historical conflicting live slots must be reconciled under the writer barrier
-- before migration; they cannot safely be guessed into terminal states here.
CREATE UNIQUE INDEX lifecycle_membership_live ON access.lifecycle_membership_slot
  (route, organization_id, member_account_id) WHERE NOT terminal;

-- Exact source-change cursor probes must not walk one member's role history.
CREATE INDEX organization_member_change ON access.organization_member
  (route, organization_id, member_account_id, transaction_id);

-- migrate:down
-- Forward only: reservations, terminal proof and coverage cannot be rolled back.
