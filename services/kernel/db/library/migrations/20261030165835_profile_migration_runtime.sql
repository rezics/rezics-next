-- migrate:up
ALTER TABLE library.fact_source_head
  ADD COLUMN profile_migration_phase text NOT NULL DEFAULT 'legacy',
  ADD COLUMN profile_migration_digest text,
  ADD COLUMN profile_migration_after uuid,
  ADD CONSTRAINT profile_migration_control CHECK (
    profile_migration_phase IN ('legacy', 'entry', 'session', 'copy', 'ready') AND
    (profile_migration_digest IS NULL OR profile_migration_digest ~ '^sha256:[0-9a-f]{64}$') AND
    (profile_migration_phase IN ('legacy', 'ready') OR profile_migration_digest IS NOT NULL) AND
    (profile_migration_phase NOT IN ('legacy', 'ready') OR profile_migration_after IS NULL)
  );

-- Serialize every live fact writer on the existing owner source head. The first
-- current writer uses four indexed pending probes, never an owner count/scan.
CREATE FUNCTION library.fence_profile_migration_writer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  phase text;
BEGIN
  -- Retained copies are outside the live pin migration. Their exact Undo must
  -- pass the live writer fence when it clears deletion_id.
  IF TG_TABLE_NAME = 'copy' THEN
    IF NEW.deletion_id IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO library.fact_source_head (route, account_id, generation)
    VALUES (NEW.route, NEW.account_id, 1)
    ON CONFLICT (route, account_id) DO NOTHING;
  SELECT profile_migration_phase INTO phase FROM library.fact_source_head
    WHERE route = NEW.route AND account_id = NEW.account_id FOR UPDATE;
  IF phase = 'legacy' AND NEW.library_profile_pin IS NOT NULL AND NOT (
    EXISTS (SELECT 1 FROM library.entry
      WHERE route = NEW.route AND account_id = NEW.account_id AND library_profile_pin IS NULL LIMIT 1) OR
    EXISTS (SELECT 1 FROM library.progress_session
      WHERE route = NEW.route AND account_id = NEW.account_id AND library_profile_pin IS NULL LIMIT 1) OR
    EXISTS (SELECT 1 FROM library.copy
      WHERE route = NEW.route AND account_id = NEW.account_id
        AND library_profile_pin IS NULL LIMIT 1) OR
    EXISTS (SELECT 1 FROM library.entry_deleted
      WHERE route = NEW.route AND account_id = NEW.account_id AND library_profile_pin IS NULL LIMIT 1)
  ) THEN
    UPDATE library.fact_source_head SET profile_migration_phase = 'ready'
      WHERE route = NEW.route AND account_id = NEW.account_id;
    phase := 'ready';
  END IF;
  IF NEW.library_profile_pin IS NULL AND phase <> 'legacy' THEN
    IF phase = 'ready' OR TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Library owner no longer admits unpinned facts' USING ERRCODE = '23514';
    END IF;
    IF OLD.library_profile_pin IS NOT NULL OR (OLD.route, OLD.account_id) IS DISTINCT FROM (NEW.route, NEW.account_id) THEN
      RAISE EXCEPTION 'Library migration cannot admit a new unpinned fact' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'entry' THEN
      IF OLD.subject_id IS DISTINCT FROM NEW.subject_id THEN
        RAISE EXCEPTION 'Library migration requires a stable unpinned entry key' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'progress_session' THEN
      IF OLD.session_id IS DISTINCT FROM NEW.session_id THEN
        RAISE EXCEPTION 'Library migration requires a stable unpinned session key' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'copy' THEN
      IF OLD.deletion_id IS NOT NULL OR OLD.copy_id IS DISTINCT FROM NEW.copy_id THEN
        RAISE EXCEPTION 'Library migration cannot admit a new unpinned fact' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entry_profile_migration_writer BEFORE INSERT OR UPDATE ON library.entry
  FOR EACH ROW EXECUTE FUNCTION library.fence_profile_migration_writer();
CREATE TRIGGER session_profile_migration_writer BEFORE INSERT OR UPDATE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.fence_profile_migration_writer();
CREATE TRIGGER copy_profile_migration_writer BEFORE INSERT OR UPDATE ON library.copy
  FOR EACH ROW EXECUTE FUNCTION library.fence_profile_migration_writer();

CREATE INDEX copy_live_profile_pending ON library.copy (route, account_id, copy_id)
  WHERE library_profile_pin IS NULL AND deletion_id IS NULL;

CREATE INDEX entry_deleted_profile_pending ON library.entry_deleted (route, account_id, deletion_id)
  WHERE library_profile_pin IS NULL;

-- migrate:down
-- Forward-only owner cutover.
