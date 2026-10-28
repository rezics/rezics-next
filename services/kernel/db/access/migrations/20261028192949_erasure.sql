-- migrate:up
CREATE TABLE access.erasure (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (completed_at IS NULL OR completed_at >= at),
  FOREIGN KEY (route, account_id) REFERENCES access.account (route, account_id)
);

CREATE TABLE access.erasure_acknowledgement (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  participant text NOT NULL CHECK (length(participant) BETWEEN 1 AND 64),
  outcome text NOT NULL CHECK (outcome IN ('erased', 'none')),
  PRIMARY KEY (route, account_id, participant),
  FOREIGN KEY (route, account_id) REFERENCES access.erasure (route, account_id)
);

CREATE FUNCTION access.guard_erasure() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Erasure records are permanent' USING ERRCODE = '23514';
  END IF;
  IF NEW.route IS DISTINCT FROM OLD.route OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.at IS DISTINCT FROM OLD.at
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'Erasure records cannot reopen or change identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER erasure_guard BEFORE UPDATE OR DELETE ON access.erasure
  FOR EACH ROW EXECUTE FUNCTION access.guard_erasure();

CREATE FUNCTION access.guard_erasure_acknowledgement() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Erasure acknowledgements are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER erasure_acknowledgement_guard BEFORE UPDATE OR DELETE ON access.erasure_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION access.guard_erasure_acknowledgement();

-- migrate:down
DROP TABLE access.erasure_acknowledgement;
DROP TABLE access.erasure;
DROP FUNCTION access.guard_erasure_acknowledgement();
DROP FUNCTION access.guard_erasure();
