-- migrate:up
-- Chronological access on the SAME original directory. These are derived seek keys,
-- never Continue membership, canonical identity, accepted meaning or permission.
ALTER TABLE library.owner_member_index
  ADD COLUMN activity_at timestamptz,
  ADD COLUMN activity_unknown boolean NOT NULL DEFAULT true;
ALTER TABLE library.owner_index_control
  ADD COLUMN chronology_ready boolean NOT NULL DEFAULT false,
  ADD COLUMN activity_after_subject uuid;
CREATE INDEX owner_index_activity ON library.owner_member_index
  (route,account_id,activity_at DESC,subject_id) WHERE activity_at IS NOT NULL;
CREATE INDEX owner_index_activity_unknown ON library.owner_member_index
  (route,account_id,subject_id) WHERE activity_unknown;

CREATE FUNCTION library.owner_original_activity(r integer,a uuid,s uuid)
RETURNS TABLE(activity_at timestamptz,activity_unknown boolean) LANGUAGE sql STABLE AS $$
  SELECT GREATEST(
    (SELECT e.activity_at FROM library.entry e WHERE e.route=r AND e.account_id=a AND e.subject_id=s),
    (SELECT h.last_changed_at FROM library.progress_head h WHERE h.route=r AND h.account_id=a AND h.subject_id=s)
  ), EXISTS(SELECT 1 FROM library.entry e WHERE e.route=r AND e.account_id=a AND e.subject_id=s
      AND e.activity_at IS NULL)
    OR (EXISTS(SELECT 1 FROM library.progress_session p WHERE p.route=r AND p.account_id=a AND p.subject_id=s)
      AND NOT EXISTS(SELECT 1 FROM library.progress_head h WHERE h.route=r AND h.account_id=a AND h.subject_id=s
        AND h.last_changed_at IS NOT NULL));
$$;
CREATE FUNCTION library.initialize_owner_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT a.activity_at,a.activity_unknown INTO NEW.activity_at,NEW.activity_unknown
    FROM library.owner_original_activity(NEW.route,NEW.account_id,NEW.subject_id) a;
  RETURN NEW;
END;
$$;
CREATE TRIGGER owner_index_activity_insert BEFORE INSERT ON library.owner_member_index
  FOR EACH ROW EXECUTE FUNCTION library.initialize_owner_activity();

CREATE FUNCTION library.refresh_owner_activity(r integer,a uuid,s uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE library.owner_member_index i SET activity_at=v.activity_at,activity_unknown=v.activity_unknown
    FROM library.owner_original_activity(r,a,s) v
    WHERE i.route=r AND i.account_id=a AND i.subject_id=s
      AND (i.activity_at,i.activity_unknown) IS DISTINCT FROM (v.activity_at,v.activity_unknown);
$$;
CREATE FUNCTION library.maintain_owner_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    PERFORM library.refresh_owner_activity(OLD.route,OLD.account_id,OLD.subject_id);
  END IF;
  IF TG_OP<>'DELETE' THEN
    PERFORM library.refresh_owner_activity(NEW.route,NEW.account_id,NEW.subject_id);
  END IF;
  RETURN NULL;
END;
$$;
-- Run after the ordinary native writers and structural directory hooks. Replay,
-- rejected commands and rolled-back transactions cannot advance a seek key.
CREATE TRIGGER zzz_owner_activity_entry_rows AFTER INSERT OR DELETE ON library.entry
  FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_activity();
CREATE TRIGGER zzz_owner_activity_entry_update AFTER UPDATE OF activity_at,subject_id ON library.entry
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION library.maintain_owner_activity();
CREATE TRIGGER zzz_owner_activity_progress_rows AFTER INSERT OR DELETE ON library.progress_head
  FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_activity();
CREATE TRIGGER zzz_owner_activity_progress_update AFTER UPDATE OF last_changed_at,subject_id ON library.progress_head
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION library.maintain_owner_activity();
-- No new erasure locator: keys/coverage are columns on the existing owner directory
-- and control rows, removed by their ordinary bounded erasure phases.
-- Presentation chooses the supported release digest without scanning an owner's release history.
CREATE INDEX owner_index_state_presentation ON library.owner_index_state
  (route,account_id,collection_id,(pin->>'releaseDigest'),pin);
-- migrate:down
-- Forward only: removing writer coverage would invalidate chronology readiness.
