-- migrate:up
-- Existing owners stay behind a durable upgrade barrier until bounded pages
-- have trimmed their history. New owners start with an empty neighborhood.
ALTER TABLE "user" ADD COLUMN sessions_bounded boolean NOT NULL DEFAULT false;
ALTER TABLE "user" ALTER COLUMN sessions_bounded SET DEFAULT true;
CREATE INDEX session_owner_oldest ON session ("userId", "createdAt", id);
CREATE INDEX session_expiry ON session ("expiresAt", id);
CREATE INDEX session_upgrade_owner ON "user" (id) WHERE NOT sessions_bounded;

CREATE FUNCTION auth_assert_session_capacity(owner_id text, serialize boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE ready boolean;
BEGIN
  IF serialize THEN
    SELECT sessions_bounded INTO ready FROM "user" WHERE id=owner_id FOR UPDATE;
  ELSE
    SELECT sessions_bounded INTO ready FROM "user" WHERE id=owner_id;
  END IF;
  IF ready IS false THEN
    RAISE EXCEPTION 'Session history upgrade required' USING ERRCODE='55000';
  END IF;
END $$;

CREATE FUNCTION auth_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys text[];
BEGIN
  -- Runs inside the native INSERT's connection and transaction. The owner row
  -- lock survives through the INSERT and its native FK checks/commit/rollback.
  PERFORM auth_assert_session_capacity(NEW."userId", true);
  -- Do not let eviction erase a conflicting key and turn an invalid native
  -- INSERT into replacement of an existing session.
  IF EXISTS (SELECT 1 FROM session WHERE id=NEW.id) OR
     EXISTS (SELECT 1 FROM session WHERE token=NEW.token) THEN
    RAISE EXCEPTION 'Duplicate session key' USING ERRCODE='23505';
  END IF;
  SELECT array_agg(id ORDER BY "createdAt", id) INTO keys FROM (
    SELECT id, "createdAt" FROM session WHERE "userId"=NEW."userId"
    ORDER BY "createdAt", id LIMIT 64
  ) bounded;
  IF cardinality(keys)=64 THEN
    DELETE FROM session WHERE id=keys[1];
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_capacity BEFORE INSERT ON session
FOR EACH ROW EXECUTE FUNCTION auth_session_insert();

CREATE FUNCTION auth_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW."userId") IS DISTINCT FROM (OLD.id, OLD."userId") THEN
    RAISE EXCEPTION 'Session identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_identity BEFORE UPDATE OF id, "userId" ON session
FOR EACH ROW EXECUTE FUNCTION auth_session_identity();

CREATE FUNCTION auth_revoke_sessions(owner_id text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  PERFORM auth_assert_session_capacity(owner_id, true);
  DELETE FROM session WHERE "userId"=owner_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;

CREATE FUNCTION auth_session_erasure_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.sessions_bounded THEN
    RAISE EXCEPTION 'Session history upgrade required' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER session_erasure_barrier BEFORE DELETE ON "user"
FOR EACH ROW EXECUTE FUNCTION auth_session_erasure_barrier();

CREATE FUNCTION auth_trim_session_history(owner_id text, batch integer)
RETURNS TABLE(deleted integer, ready boolean) LANGUAGE plpgsql AS $$
BEGIN
  IF batch IS NULL OR batch < 1 OR batch > 1000 THEN
    RAISE EXCEPTION 'Invalid session trimming batch' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM "user" WHERE id=owner_id FOR UPDATE;
  -- Keep the newest 64, reading/deleting only one admitted page beyond them.
  DELETE FROM session WHERE id=ANY(ARRAY(
    SELECT id FROM session WHERE "userId"=owner_id
    ORDER BY "createdAt" DESC, id DESC OFFSET 64 LIMIT batch
  ));
  GET DIAGNOSTICS deleted = ROW_COUNT;
  ready := NOT EXISTS (
    SELECT 1 FROM session WHERE "userId"=owner_id
    ORDER BY "createdAt" DESC, id DESC OFFSET 64 LIMIT 1
  );
  IF ready THEN UPDATE "user" SET sessions_bounded=true WHERE id=owner_id; END IF;
  RETURN NEXT;
END $$;

-- migrate:down
-- Forward-only: capacity and upgrade barriers must survive application rollback.
