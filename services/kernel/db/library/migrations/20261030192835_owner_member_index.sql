-- migrate:up
-- One structural ORIGINAL directory, never a copy of a native fact or a builtin membership cache.
CREATE TABLE library.owner_member_support (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  family text NOT NULL CHECK (family IN ('entry','label','session','copy')),
  pin jsonb NOT NULL,
  PRIMARY KEY (route, account_id, subject_id, family, pin),
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (route = (get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))),
  CHECK (pin = '{}'::jsonb OR library.library_profile_pin_valid(pin))
);
CREATE INDEX owner_member_support_pin ON library.owner_member_support
  (route, account_id, pin, subject_id, family);
CREATE TABLE library.owner_member_index (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, subject_id),
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (route = (get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)))
);
CREATE INDEX owner_index_label_live ON library.label_assignment(route,account_id,subject_id,label_id)
  WHERE deleted_at IS NULL;
CREATE INDEX owner_index_label_identified ON library.label_assignment(route,account_id,subject_id,label_id)
  WHERE deleted_at IS NULL AND slot_no IS NOT NULL AND assignment_id IS NOT NULL;
CREATE INDEX owner_index_label_legacy ON library.label_assignment(route,account_id,subject_id,label_id)
  WHERE deleted_at IS NULL AND (slot_no IS NULL OR assignment_id IS NULL);
CREATE TABLE library.owner_index_control (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  phase text NOT NULL DEFAULT 'entry' CHECK (phase IN ('entry','session','copy','label','ready')),
  after_subject uuid,
  after_fact uuid,
  PRIMARY KEY (route, account_id),
  CHECK ((after_subject IS NULL) = (after_fact IS NULL)),
  CHECK (phase <> 'ready' OR after_subject IS NULL),
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (route = (get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)))
);
-- One retained parent frontier, not a per-child witness or synchronous owner fanout.
CREATE TABLE library.owner_index_label_repair (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  label_id uuid NOT NULL,
  after_subject uuid,
  PRIMARY KEY(route,account_id,label_id)
);
CREATE FUNCTION library.queue_owner_label_repair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.deleted_at IS NULL) = (NEW.deleted_at IS NULL) THEN RETURN NULL; END IF;
  INSERT INTO library.owner_index_label_repair(route,account_id,label_id)
    VALUES(OLD.route,OLD.account_id,OLD.label_id)
    ON CONFLICT(route,account_id,label_id) DO UPDATE SET after_subject=NULL;
  RETURN NULL;
END;
$$;
CREATE TRIGGER zz_owner_index_label_parent AFTER UPDATE OF deleted_at OR DELETE ON library.personal_label
  FOR EACH ROW EXECUTE FUNCTION library.queue_owner_label_repair();
-- Qualified same-pin native EXISTS; one million sessions/copies do not multiply structural rows.
CREATE INDEX owner_index_entry_scope ON library.entry
  (route, account_id, subject_id, (COALESCE(library_profile_pin, '{}'::jsonb))) WHERE true;
CREATE INDEX owner_index_session_scope ON library.progress_session
  (route, account_id, subject_id, (COALESCE(library_profile_pin, '{}'::jsonb))) WHERE true;
CREATE INDEX owner_index_copy_scope ON library.copy
  (route, account_id, subject_id, (COALESCE(library_profile_pin, '{}'::jsonb))) WHERE deletion_id IS NULL;
-- First/last owner pin scopes support descriptor work without visiting fact histories.
CREATE TABLE library.owner_index_pin (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  pin jsonb NOT NULL,
  meaning_ready boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,account_id,pin)
);
CREATE INDEX owner_index_pending_pin ON library.owner_index_pin(route,account_id,pin) WHERE NOT meaning_ready;
CREATE TABLE library.owner_index_state (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  pin jsonb NOT NULL,
  collection_id uuid NOT NULL,
  labels jsonb NOT NULL,
  PRIMARY KEY (route,account_id,pin,collection_id),
  FOREIGN KEY (route,account_id,pin) REFERENCES library.owner_index_pin ON DELETE CASCADE
);
CREATE INDEX owner_index_state_collection ON library.owner_index_state(route,account_id,collection_id,pin);
CREATE FUNCTION library.refresh_owner_member_scope(r integer, a uuid, s uuid, f text, p jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE live boolean;
BEGIN
  -- The ordinary writer already advances this point. Bootstrap takes the SAME lock before reading facts.
  PERFORM 1 FROM library.fact_source_head WHERE route=r AND account_id=a FOR UPDATE;
  IF f='entry' THEN
    SELECT EXISTS (SELECT 1 FROM library.entry WHERE route=r AND account_id=a AND subject_id=s
      AND COALESCE(library_profile_pin,'{}'::jsonb)=p) INTO live;
  ELSIF f='session' THEN
    SELECT EXISTS (SELECT 1 FROM library.progress_session WHERE route=r AND account_id=a AND subject_id=s
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
CREATE FUNCTION library.maintain_owner_member_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f text; p jsonb;
BEGIN
  f := CASE TG_TABLE_NAME WHEN 'entry' THEN 'entry' WHEN 'progress_session' THEN 'session'
    WHEN 'copy' THEN 'copy' WHEN 'label_assignment' THEN 'label' END;
  IF TG_OP <> 'INSERT' THEN
    p := CASE WHEN f='label' THEN '{}'::jsonb ELSE COALESCE(to_jsonb(OLD)->'library_profile_pin','{}'::jsonb) END;
    IF p='null'::jsonb THEN p:='{}'::jsonb; END IF;
    PERFORM library.refresh_owner_member_scope(OLD.route,OLD.account_id,OLD.subject_id,f,p);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    p := CASE WHEN f='label' THEN '{}'::jsonb ELSE COALESCE(to_jsonb(NEW)->'library_profile_pin','{}'::jsonb) END;
    IF p='null'::jsonb THEN p:='{}'::jsonb; END IF;
    PERFORM library.refresh_owner_member_scope(NEW.route,NEW.account_id,NEW.subject_id,f,p);
  END IF;
  RETURN NULL;
END;
$$;
-- AFTER source-head triggers: replay/no-effect paths never reach these hooks.
CREATE TRIGGER zz_owner_index_entry_rows AFTER INSERT OR DELETE ON library.entry
  FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();
CREATE TRIGGER zz_owner_index_entry_update AFTER UPDATE OF state, library_profile_pin, owner_write_seq ON library.entry
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION library.maintain_owner_member_scope();
-- AFTER source-head triggers: replay/no-effect paths never reach these hooks.
CREATE TRIGGER zz_owner_index_progress_session_rows AFTER INSERT OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();
CREATE TRIGGER zz_owner_index_progress_session_update AFTER UPDATE OF state, library_profile_pin, subject_id ON library.progress_session
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION library.maintain_owner_member_scope();
-- AFTER source-head triggers: replay/no-effect paths never reach these hooks.
CREATE TRIGGER zz_owner_index_copy_rows AFTER INSERT OR DELETE ON library.copy
  FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();
CREATE TRIGGER zz_owner_index_copy_update AFTER UPDATE OF deletion_id, library_profile_pin, subject_id ON library.copy
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION library.maintain_owner_member_scope();
-- AFTER source-head triggers: replay/no-effect paths never reach these hooks.
CREATE TRIGGER zz_owner_index_label_assignment_rows AFTER INSERT OR DELETE ON library.label_assignment
  FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();
CREATE TRIGGER zz_owner_index_label_assignment_update AFTER UPDATE OF deleted_at, slot_no, label_id, subject_id ON library.label_assignment
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION library.maintain_owner_member_scope();
-- Parent deletion invalidates fact_source_head immediately. Children need no synchronous fanout:
-- every label predicate checks the current parent; bounded directory repair removes obsolete candidates.
-- A5: owner_member_support by (route,account_id,subject_id,family,pin), then
-- owner_member_index by (route,account_id,subject_id), then owner_index_control by (route,account_id).
-- Erase only after native fact hooks have stopped, and before fact_source_head.
-- migrate:down
-- Forward only: dropping writer coverage would make a built directory incomplete.
