-- migrate:up
ALTER TABLE community.realm
  ADD COLUMN ownership_state text NOT NULL DEFAULT 'owned',
  ADD COLUMN orphaned_at timestamptz,
  ADD COLUMN claim_eligible_at timestamptz,
  ADD CONSTRAINT realm_ownership_check CHECK (
    (ownership_state = 'owned' AND orphaned_at IS NULL AND claim_eligible_at IS NULL)
    OR (ownership_state = 'orphaned' AND orphaned_at IS NOT NULL AND claim_eligible_at IS NOT NULL
        AND isfinite(orphaned_at) AND claim_eligible_at = orphaned_at + interval '720 hours')
  );

CREATE FUNCTION community.guard_realm_orphan_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ownership_state = 'orphaned' AND NEW.ownership_state = 'orphaned'
     AND ROW(NEW.orphaned_at, NEW.claim_eligible_at) IS DISTINCT FROM ROW(OLD.orphaned_at, OLD.claim_eligible_at) THEN
    RAISE EXCEPTION 'An orphaned Realm retains its original claim deadline' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_orphan_deadline BEFORE UPDATE ON community.realm
  FOR EACH ROW EXECUTE FUNCTION community.guard_realm_orphan_deadline();

CREATE TABLE community.realm_claim_request (
  route integer NOT NULL,
  realm_id uuid NOT NULL,
  request_id uuid NOT NULL,
  account_id uuid NOT NULL,
  orphaned_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state = 'pending'),
  PRIMARY KEY (route, realm_id, request_id),
  UNIQUE (route, realm_id, orphaned_at, account_id),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id),
  CHECK (route = ((get_byte(uuid_send(request_id), 10) * 256) + get_byte(uuid_send(request_id), 11)))
);

-- migrate:down
DROP TABLE community.realm_claim_request;
DROP TRIGGER realm_orphan_deadline ON community.realm;
DROP FUNCTION community.guard_realm_orphan_deadline();
ALTER TABLE community.realm DROP CONSTRAINT realm_ownership_check,
  DROP COLUMN claim_eligible_at, DROP COLUMN orphaned_at, DROP COLUMN ownership_state;
