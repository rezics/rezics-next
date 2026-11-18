-- migrate:up
ALTER TABLE library.owner_index_control
  ADD COLUMN personal_coverage_ready boolean NOT NULL DEFAULT false,
  ADD COLUMN personal_coverage_after uuid;

CREATE OR REPLACE FUNCTION library.refresh_owner_member_scope(r integer, a uuid, s uuid, f text, p jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE live boolean;
BEGIN
  -- The ordinary writer already advances this point. Bootstrap takes the SAME lock before reading facts.
  PERFORM 1 FROM library.fact_source_head WHERE route=r AND account_id=a FOR UPDATE;
  IF f='entry' THEN
    SELECT EXISTS (SELECT 1 FROM library.entry WHERE route=r AND account_id=a AND subject_id=s
      AND COALESCE(library_profile_pin,'{}'::jsonb)=p) OR
      (p='{}'::jsonb AND EXISTS (SELECT 1 FROM library.entry_personal_fact x WHERE x.route=r AND x.account_id=a
        AND x.subject_id=s AND (x.note IS NOT NULL OR x.priority IS NOT NULL OR EXISTS (
          SELECT 1 FROM library.entry_source_observation o WHERE o.route=x.route AND o.account_id=x.account_id
            AND o.subject_id=x.subject_id)))) INTO live;
  ELSIF f='session' THEN
    SELECT EXISTS (SELECT 1 FROM library.progress_session WHERE state <> 'retired' AND route=r AND account_id=a AND subject_id=s
      AND COALESCE(library_profile_pin,'{}'::jsonb)=p) INTO live;
  ELSIF f='copy' THEN
    SELECT EXISTS (SELECT 1 FROM library.copy WHERE route=r AND account_id=a AND subject_id=s
      AND deletion_id IS NULL AND COALESCE(library_profile_pin,'{}'::jsonb)=p) INTO live;
  ELSIF f='label' THEN
    -- Legacy uncertainty is a bounded indexed point, never an unbounded walk over hidden legacy parents.
    SELECT EXISTS (SELECT 1 FROM library.label_assignment x WHERE x.route=r AND x.account_id=a AND x.subject_id=s
      AND x.deleted_at IS NULL AND (x.slot_no IS NULL OR x.assignment_id IS NULL)) OR
    EXISTS (SELECT 1 FROM library.label_assignment x WHERE x.route=r AND x.account_id=a AND x.subject_id=s
      AND x.deleted_at IS NULL AND x.slot_no IS NOT NULL AND x.assignment_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM library.personal_label l WHERE l.route=r AND l.account_id=a AND l.label_id=x.label_id
          AND l.deleted_at IS NULL)) INTO live;
  ELSE RAISE EXCEPTION 'Unknown owner member family'; END IF;
  IF live THEN
    INSERT INTO library.owner_member_support VALUES(r,a,s,f,p) ON CONFLICT DO NOTHING;
    INSERT INTO library.owner_member_index VALUES(r,a,s) ON CONFLICT DO NOTHING;
    INSERT INTO library.owner_index_pin(route,account_id,pin) VALUES(r,a,p) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM library.owner_member_support WHERE route=r AND account_id=a AND subject_id=s AND family=f AND pin=p;
    -- One released profile has at most 64 states; cascades touch that bounded metadata, never native facts.
    DELETE FROM library.owner_index_pin WHERE route=r AND account_id=a AND pin=p AND NOT EXISTS (
      SELECT 1 FROM library.owner_member_support WHERE route=r AND account_id=a AND pin=p);
    DELETE FROM library.owner_member_index WHERE route=r AND account_id=a AND subject_id=s AND NOT EXISTS (
      SELECT 1 FROM library.owner_member_support WHERE route=r AND account_id=a AND subject_id=s)
      AND NOT EXISTS (SELECT 1 FROM library.entry_clear WHERE route=r AND account_id=a AND subject_id=s);
  END IF;
  -- Structural reduction coverage is independent of live family support and accepted pins.
  IF EXISTS (SELECT 1 FROM library.entry_clear WHERE route=r AND account_id=a AND subject_id=s) THEN
    INSERT INTO library.owner_member_index(route,account_id,subject_id) VALUES(r,a,s) ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

-- migrate:down
-- Forward only. Existing owners may already have repaired independent personal support.
