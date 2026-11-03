-- migrate:up
ALTER TABLE library.progress_session DROP CONSTRAINT progress_session_state_check,
  ADD CONSTRAINT progress_session_state_check CHECK (state IN ('active','completed','abandoned','retired'));
-- A retired occurrence remains private audit data until terminal account erasure.
-- All live scans can seek without walking retained retired occurrences.
CREATE INDEX progress_session_live_page ON library.progress_session
  (route,account_id,subject_id,started_at DESC,session_id) WHERE state <> 'retired';
CREATE INDEX progress_session_live_owner ON library.progress_session
  (route,account_id,session_id) WHERE state <> 'retired';
CREATE INDEX progress_session_live_source ON library.progress_session
  (route,account_id,subject_id,session_id) WHERE state <> 'retired';
DROP INDEX library.owner_index_session_scope;
CREATE INDEX owner_index_session_scope ON library.progress_session
  (route,account_id,subject_id,(COALESCE(library_profile_pin,'{}'::jsonb))) WHERE state <> 'retired';
CREATE OR REPLACE FUNCTION library.refresh_owner_member_scope(r integer, a uuid, s uuid, f text, p jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE live boolean;
BEGIN
  -- The ordinary writer already advances this point. Bootstrap takes the SAME lock before reading facts.
  PERFORM 1 FROM library.fact_source_head WHERE route=r AND account_id=a FOR UPDATE;
  IF f='entry' THEN
    SELECT EXISTS (SELECT 1 FROM library.entry WHERE route=r AND account_id=a AND subject_id=s
      AND COALESCE(library_profile_pin,'{}'::jsonb)=p) INTO live;
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
      SELECT 1 FROM library.owner_member_support WHERE route=r AND account_id=a AND subject_id=s);
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION library.owner_original_activity(r integer,a uuid,s uuid)
RETURNS TABLE(activity_at timestamptz,activity_unknown boolean) LANGUAGE sql STABLE AS $$
  SELECT GREATEST(
    (SELECT e.activity_at FROM library.entry e WHERE e.route=r AND e.account_id=a AND e.subject_id=s),
    (SELECT h.last_changed_at FROM library.progress_head h WHERE h.route=r AND h.account_id=a AND h.subject_id=s)
  ), EXISTS(SELECT 1 FROM library.entry e WHERE e.route=r AND e.account_id=a AND e.subject_id=s
      AND e.activity_at IS NULL)
    OR (EXISTS(SELECT 1 FROM library.progress_session p WHERE p.state <> 'retired' AND p.route=r AND p.account_id=a AND p.subject_id=s)
      AND NOT EXISTS(SELECT 1 FROM library.progress_head h WHERE h.route=r AND h.account_id=a AND h.subject_id=s
        AND h.last_changed_at IS NOT NULL));
$$;
-- Existing state-update hooks atomically refresh support and invalidate native sources.
-- The existing child-first account eraser visits ALL sessions, including retired ones.
-- migrate:down
-- Forward only: preserve occurrence history and lifecycle meaning.
