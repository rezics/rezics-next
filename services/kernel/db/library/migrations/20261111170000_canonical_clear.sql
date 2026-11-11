-- migrate:up
CREATE TABLE library.entry_clear (
    route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    owner_write_seq bigint NOT NULL CHECK (owner_write_seq > 0),
    transaction_id uuid NOT NULL,
    PRIMARY KEY (route, account_id, subject_id),
    CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);
COMMENT ON TABLE library.entry_clear IS 'Latest private original-keyed clear order. Reduction evidence only, never live entry or owner presence. Retained independently of Undo payload expiry until terminal account erasure.';

CREATE OR REPLACE FUNCTION library.refresh_owner_member_scope(r integer, a uuid, s uuid, f text, p jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
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
      SELECT 1 FROM library.owner_member_support WHERE route=r AND account_id=a AND subject_id=s)
      AND NOT EXISTS (SELECT 1 FROM library.entry_clear WHERE route=r AND account_id=a AND subject_id=s);
  END IF;
  -- Structural reduction coverage is independent of live family support and accepted pins.
  IF EXISTS (SELECT 1 FROM library.entry_clear WHERE route=r AND account_id=a AND subject_id=s) THEN
    INSERT INTO library.owner_member_index(route,account_id,subject_id) VALUES(r,a,s) ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

CREATE FUNCTION library.maintain_entry_clear_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM library.owner_member_index i
    WHERE i.route=OLD.route AND i.account_id=OLD.account_id AND i.subject_id=OLD.subject_id
      AND NOT EXISTS (SELECT 1 FROM library.owner_member_support s
        WHERE s.route=i.route AND s.account_id=i.account_id AND s.subject_id=i.subject_id)
      AND NOT EXISTS (SELECT 1 FROM library.entry_clear c
        WHERE c.route=i.route AND c.account_id=i.account_id AND c.subject_id=i.subject_id);
  ELSE
    INSERT INTO library.owner_member_index(route,account_id,subject_id)
      VALUES(NEW.route,NEW.account_id,NEW.subject_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER entry_clear_fact_source_rows AFTER INSERT OR DELETE ON library.entry_clear
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER entry_clear_fact_source_update AFTER UPDATE ON library.entry_clear
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER entry_clear_native_writer AFTER INSERT OR DELETE OR UPDATE ON library.entry_clear
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER zz_entry_clear_owner_scope AFTER INSERT OR DELETE OR UPDATE ON library.entry_clear
  FOR EACH ROW EXECUTE FUNCTION library.maintain_entry_clear_scope();

-- migrate:down
-- Forward only: dropping clear evidence can expose an older aliased state.
