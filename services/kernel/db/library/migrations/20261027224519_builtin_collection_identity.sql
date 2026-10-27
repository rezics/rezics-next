-- migrate:up
ALTER TABLE library.collection
  ADD COLUMN membership_kind text NOT NULL DEFAULT 'curated'
    CHECK (membership_kind IN ('curated', 'dynamic')),
  ADD COLUMN builtin_kind text CHECK (builtin_kind IN ('everything', 'state')),
  ADD COLUMN builtin_release_digest text,
  ADD COLUMN builtin_profile_id text,
  ADD COLUMN builtin_state_set_id text,
  ADD COLUMN builtin_state_id text,
  ADD CONSTRAINT collection_builtin_identity_check CHECK (
    CASE membership_kind
      WHEN 'curated' THEN
        builtin_kind IS NULL AND builtin_release_digest IS NULL AND
        builtin_profile_id IS NULL AND builtin_state_set_id IS NULL AND builtin_state_id IS NULL
      WHEN 'dynamic' THEN
        CASE builtin_kind
          WHEN 'everything' THEN
            builtin_release_digest IS NULL AND builtin_profile_id IS NULL AND
            builtin_state_set_id IS NULL AND builtin_state_id IS NULL
          WHEN 'state' THEN
            builtin_release_digest IS NOT NULL AND builtin_profile_id IS NOT NULL AND
            builtin_state_set_id IS NOT NULL AND builtin_state_id IS NOT NULL AND
            octet_length(builtin_release_digest) = 71 AND
            builtin_release_digest COLLATE "C" ~ '\Asha256:[0-9a-f]{64}\Z' AND
            octet_length(builtin_profile_id) BETWEEN 1 AND 64 AND
            builtin_profile_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z' AND
            octet_length(builtin_state_set_id) BETWEEN 1 AND 64 AND
            builtin_state_set_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z' AND
            octet_length(builtin_state_id) BETWEEN 1 AND 64 AND
            builtin_state_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'
          ELSE
            -- Erased private references do not establish a ready membership source.
            builtin_kind IS NULL AND builtin_release_digest IS NULL AND
            builtin_profile_id IS NULL AND builtin_state_set_id IS NULL AND builtin_state_id IS NULL
        END
      ELSE false
    END
  );

CREATE UNIQUE INDEX collection_builtin_everything_identity
  ON library.collection (route, curator_account_id)
  WHERE builtin_kind = 'everything';

-- The accepted release addresses the predicate revision, not the stable state identity.
CREATE UNIQUE INDEX collection_builtin_state_identity
  ON library.collection (route, curator_account_id, builtin_profile_id, builtin_state_set_id, builtin_state_id)
  WHERE builtin_kind = 'state';

CREATE FUNCTION library.guard_collection_membership_kind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.membership_kind IS DISTINCT FROM OLD.membership_kind THEN
    RAISE EXCEPTION 'Collection membership kind cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_membership_kind_immutable
BEFORE UPDATE OF membership_kind ON library.collection
FOR EACH ROW EXECUTE FUNCTION library.guard_collection_membership_kind();

-- migrate:down
-- Forward only: built-in identities must not be converted to curated Collections.
