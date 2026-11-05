-- migrate:up
-- Native work locators and decisions, never a second grant/owner authority.
CREATE TABLE access.realm_erasure_succession (
  route integer NOT NULL,
  resource_id uuid NOT NULL,
  account_id uuid NOT NULL,
  source_route integer NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_at timestamptz NOT NULL,
  frontier jsonb,
  cursor_role text,
  cursor_kind text,
  cursor_subject_id uuid,
  cursor_subject_role text,
  cursor_interval_key bigint,
  best_account_id uuid,
  best_role text,
  best_valid tstzrange,
  best_interval_key bigint,
  decision_state text CHECK (decision_state IN ('owned', 'orphaned')),
  decision_operation_id uuid,
  decided_at timestamptz,
  PRIMARY KEY (route, resource_id, account_id),
  CHECK (route = (get_byte(uuid_send(resource_id),10)*256+get_byte(uuid_send(resource_id),11))),
  CHECK (source_route = (get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))),
  CHECK ((decision_state IS NULL) = (decision_operation_id IS NULL)),
  CHECK ((decision_state IS NULL) = (decided_at IS NULL)),
  CHECK (decision_state IS DISTINCT FROM 'owned' OR best_account_id IS NOT NULL),
  CHECK (decision_state IS DISTINCT FROM 'orphaned' OR best_account_id IS NULL)
);
CREATE INDEX realm_erasure_succession_account ON access.realm_erasure_succession(account_id,route,resource_id);
CREATE INDEX realm_erasure_succession_candidate ON access.realm_erasure_succession(best_account_id,route,resource_id,account_id)
  WHERE best_account_id IS NOT NULL;
CREATE INDEX realm_erasure_succession_cursor ON access.realm_erasure_succession(cursor_subject_id,route,resource_id,account_id)
  WHERE cursor_subject_id IS NOT NULL;

CREATE FUNCTION access.guard_realm_erasure_succession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Realm succession source custody has no consumer closure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route,NEW.resource_id,NEW.account_id,NEW.source_route,NEW.source_version,NEW.source_at)
       IS DISTINCT FROM ROW(OLD.route,OLD.resource_id,OLD.account_id,OLD.source_route,OLD.source_version,OLD.source_at)
     OR (OLD.decision_state IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Realm succession source and terminal decision are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER realm_erasure_succession_custody BEFORE UPDATE OR DELETE ON access.realm_erasure_succession
  FOR EACH ROW EXECUTE FUNCTION access.guard_realm_erasure_succession();

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Native Realm succession source custody cannot be rolled back';
END; $$;
