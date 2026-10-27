-- migrate:up
ALTER TABLE library.entry ADD COLUMN library_profile_pin jsonb;
ALTER TABLE library.progress_session ADD COLUMN library_profile_pin jsonb;
ALTER TABLE library.copy
  ADD COLUMN library_profile_pin jsonb,
  ADD COLUMN kind text;

CREATE FUNCTION library.library_profile_pin_valid(pin jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(pin) IS DISTINCT FROM 'object' THEN false
    WHEN (SELECT count(*) FROM jsonb_object_keys(pin)) <> 4 THEN false
    WHEN NOT (pin ?& ARRAY['provenance', 'releaseDigest', 'acceptingType', 'profileId']) THEN false
    WHEN jsonb_typeof(pin -> 'provenance') IS DISTINCT FROM 'string' THEN false
    WHEN jsonb_typeof(pin -> 'releaseDigest') IS DISTINCT FROM 'string' THEN false
    WHEN pin ->> 'releaseDigest' !~ '^sha256:[0-9a-f]{64}$' THEN false
    WHEN pin ->> 'provenance' = 'profile' THEN
      jsonb_typeof(pin -> 'acceptingType') = 'string' AND pin ->> 'acceptingType' <> '' AND
      jsonb_typeof(pin -> 'profileId') = 'string' AND pin ->> 'profileId' <> ''
    WHEN pin ->> 'provenance' = 'legacy' THEN
      jsonb_typeof(pin -> 'profileId') = 'string' AND pin ->> 'profileId' = 'legacy-fixed-v1' AND
      (jsonb_typeof(pin -> 'acceptingType') = 'null' OR
        (jsonb_typeof(pin -> 'acceptingType') = 'string' AND pin ->> 'acceptingType' <> ''))
    ELSE false
  END
$$;

ALTER TABLE library.entry
  ADD CONSTRAINT entry_library_profile_pin_check
  CHECK (library_profile_pin IS NULL OR library.library_profile_pin_valid(library_profile_pin));
ALTER TABLE library.progress_session
  ADD CONSTRAINT progress_session_library_profile_pin_check
  CHECK (library_profile_pin IS NULL OR library.library_profile_pin_valid(library_profile_pin));
ALTER TABLE library.copy
  ADD CONSTRAINT copy_library_profile_pin_check
  CHECK (library_profile_pin IS NULL OR library.library_profile_pin_valid(library_profile_pin)),
  ADD CONSTRAINT copy_library_profile_kind_check
  CHECK (library_profile_pin IS NULL OR (kind IS NOT NULL AND char_length(kind) > 0));

CREATE INDEX entry_profile_pending
  ON library.entry (route, account_id, subject_id)
  WHERE library_profile_pin IS NULL;
CREATE INDEX progress_session_profile_pending
  ON library.progress_session (route, account_id, session_id)
  WHERE library_profile_pin IS NULL;
CREATE INDEX copy_profile_pending
  ON library.copy (route, account_id, copy_id)
  WHERE library_profile_pin IS NULL;

-- migrate:down
-- Forward-only: existing personal facts remain unpinned until an explicit bounded migration.
