-- migrate:up
ALTER TABLE access.account
  ADD COLUMN registration_id uuid,
  ADD COLUMN registration_expires_at timestamptz,
  ADD COLUMN authn_fenced boolean NOT NULL DEFAULT false,
  ADD COLUMN fence_receipt_id uuid;

ALTER TABLE access.handle_claim ADD COLUMN reservation_id uuid;

-- Indefinite holds on the responsible account. A later durable coordinator must
-- resolve these before deletion or automation; elapsed time never releases them.
CREATE TABLE access.lifecycle_coordination (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  related_account_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('membership', 'operator')),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, reservation_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- A terminal removal is permanent for this reservation. Delayed work cannot
-- re-add a member using a reservation whose removal has already committed.
CREATE TABLE access.lifecycle_membership_slot (
  route integer NOT NULL,
  organization_id uuid NOT NULL,
  member_account_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, organization_id, member_account_id, reservation_id),
  CHECK (route = get_byte(uuid_send(organization_id), 10) * 256 + get_byte(uuid_send(organization_id), 11))
);

-- Minimal nonsecret coordination facts, committed with the account and executor
-- fence/outbox. Private request bodies are never copied into these receipts.
CREATE TABLE access.lifecycle_fence_receipt (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  minimum_authn_epoch bigint NOT NULL CHECK (minimum_authn_epoch > 0),
  kind text NOT NULL CHECK (kind IN ('fence', 'tombstone')),
  prior_operator_account_id uuid,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, receipt_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- Guard the held account itself, so future operator commands cannot overlook a
-- membership/owner/operator hold. Both lookup keys remain on OLD's own anchor.
CREATE FUNCTION access.guard_lifecycle_responsibility() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ((NEW.operator_account_id IS DISTINCT FROM OLD.operator_account_id AND NEW.operator_account_id IS NOT NULL)
      OR (NEW.state = 'deleted' AND OLD.state <> 'deleted'))
     AND EXISTS (SELECT 1 FROM access.lifecycle_coordination
                 WHERE route = OLD.route AND account_id = OLD.account_id) THEN
    RAISE EXCEPTION 'Unresolved account responsibility' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lifecycle_responsibility BEFORE UPDATE ON access.account
FOR EACH ROW EXECUTE FUNCTION access.guard_lifecycle_responsibility();

-- migrate:down
-- Forward only: lifecycle identity, fences and unresolved responsibilities are durable.
