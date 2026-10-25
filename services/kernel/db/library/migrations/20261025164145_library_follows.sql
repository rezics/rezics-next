-- migrate:up
CREATE SCHEMA IF NOT EXISTS library;

CREATE TABLE library.follow (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  target_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('subject', 'collection', 'space')),
  state text NOT NULL CHECK (state IN ('following', 'unfollowed')),
  reason text NOT NULL CHECK (reason IN ('explicit', 'library', 'membership')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, target_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (reason = 'explicit' OR state = 'following')
);

CREATE INDEX follow_account_page
  ON library.follow (route, account_id, state, updated_at DESC, target_id);

CREATE FUNCTION library.guard_follow_target_type() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_type IS DISTINCT FROM OLD.target_type THEN
    RAISE EXCEPTION 'Follow target type cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER follow_target_type_immutable
BEFORE UPDATE OF target_type ON library.follow
FOR EACH ROW EXECUTE FUNCTION library.guard_follow_target_type();

-- migrate:down
-- Forward only: private follow history is retained with the library data.
