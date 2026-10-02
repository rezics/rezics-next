-- Manager generation tracks management commands, while recipient submission
-- and withdrawal also change the pending inbox. Its own point-read revision
-- makes continuation fail stale instead of silently skipping random UUIDs
-- inserted before the current cursor. Existing Realm gates serialize mutations
-- with reads, including trigger writes within request/decision transactions.
CREATE TABLE access.realm_join_request_inbox_revision (
  realm text PRIMARY KEY REFERENCES access.realm_admin_revision(realm),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
INSERT INTO access.realm_join_request_inbox_revision (realm)
SELECT realm FROM access.realm_admin_revision;

CREATE FUNCTION access.advance_realm_join_request_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access.realm_join_request_inbox_revision (realm,generation)
    VALUES (COALESCE(NEW.realm,OLD.realm),1)
    ON CONFLICT (realm) DO UPDATE SET generation = access.realm_join_request_inbox_revision.generation + 1;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_join_request_inbox_advance AFTER INSERT OR DELETE
  ON access.realm_join_request_pending FOR EACH ROW
  EXECUTE FUNCTION access.advance_realm_join_request_inbox();
