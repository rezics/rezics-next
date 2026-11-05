-- migrate:up
-- A group checkpoint is not participant completion. Unsupported inventory stays pending.
CREATE TABLE access.erasure_native_progress (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  progress_id uuid NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  phase integer NOT NULL DEFAULT 0 CHECK (phase >= 0),
  page integer NOT NULL DEFAULT 0 CHECK (page >= 0),
  pending text CHECK (pending IN ('handle-consumer', 'native-inventory')),
  PRIMARY KEY (route, account_id),
  FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id)
);
CREATE INDEX erasure_handle_unfinished ON access.lifecycle_handle_operation (account_id, route, operation_id)
  WHERE state = 'published';

ALTER TABLE access.handle_claim
  ALTER COLUMN account_id DROP NOT NULL,
  ALTER COLUMN transaction_id DROP NOT NULL,
  DROP CONSTRAINT handle_claim_check1,
  DROP CONSTRAINT handle_claim_state_check;
ALTER TABLE access.handle_claim ADD CONSTRAINT handle_claim_disposition CHECK (
  (state = 'retired' AND account_id IS NULL AND transaction_id IS NULL
    AND expires_at IS NULL AND reserved_until IS NULL AND reservation_id IS NULL
    AND hold_operation_id IS NULL AND hold_expected_handle IS NULL AND former_until IS NULL)
  OR (state IN ('pending', 'active', 'reserved') AND account_id IS NOT NULL AND transaction_id IS NOT NULL
    AND ((state = 'pending' AND expires_at IS NOT NULL AND reserved_until IS NULL)
      OR (state = 'active' AND expires_at IS NULL AND reserved_until IS NULL)
      OR (state = 'reserved' AND expires_at IS NULL AND reserved_until IS NOT NULL)))
);
CREATE FUNCTION access.guard_retired_handle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.state = 'retired' THEN
    RAISE EXCEPTION 'Retired handles are permanent' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.state = 'retired' THEN
    IF TG_OP <> 'UPDATE' OR OLD.state <> 'reserved' OR OLD.hold_operation_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM access.erasure e WHERE e.account_id = OLD.account_id
        AND e.route = (get_byte(uuid_send(OLD.account_id),10)*256+get_byte(uuid_send(OLD.account_id),11)))
      OR EXISTS (SELECT 1 FROM access.lifecycle_handle_operation o WHERE o.account_id = OLD.account_id
        AND o.route = (get_byte(uuid_send(OLD.account_id),10)*256+get_byte(uuid_send(OLD.account_id),11))
        AND o.state = 'published') THEN
      RAISE EXCEPTION 'Handle erasure requires a permanent obligation and finished consumer' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM access.erasure e WHERE e.account_id = NEW.account_id
    AND e.route = (get_byte(uuid_send(NEW.account_id),10)*256+get_byte(uuid_send(NEW.account_id),11))) THEN
    -- The committed deletion's real native redirect consumer may finish. No new
    -- reservation, hold, ownership or revival can cross the permanent barrier.
    IF TG_OP <> 'UPDATE' OR OLD.account_id IS DISTINCT FROM NEW.account_id
      OR OLD.state <> 'active' OR NEW.state <> 'reserved' OR NEW.hold_operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'Erased accounts cannot allocate handles' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_retired_handle BEFORE INSERT OR UPDATE OR DELETE ON access.handle_claim
  FOR EACH ROW EXECUTE FUNCTION access.guard_retired_handle();

-- migrate:down
-- Permanent ownerless allocations cannot be converted back into personal claims.
DO $$ BEGIN RAISE EXCEPTION 'Native erasure is irreversible'; END $$;
