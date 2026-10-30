-- migrate:up
-- Custody/fence metadata only; native owner rows remain the sole business authority.
CREATE TABLE library.native_source_fence (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  kind text NOT NULL CHECK (kind IN ('collection','account')),
  owner_id uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  PRIMARY KEY (route,kind,owner_id)
);
CREATE TABLE library.native_source_capture (
  route integer NOT NULL,
  capture_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  incarnation text NOT NULL CHECK (octet_length(incarnation) <= 128),
  generation bigint NOT NULL CHECK (generation >= 0),
  scope text NOT NULL CHECK (scope IN ('curated','private_builtin')),
  owner_epoch integer NOT NULL,
  receiving_epoch bigint NOT NULL CHECK (receiving_epoch > 0),
  effect_key text NOT NULL CHECK (octet_length(effect_key) BETWEEN 1 AND 256),
  collection_fence bigint NOT NULL,
  account_fence bigint NOT NULL,
  driver text NOT NULL CHECK (driver IN ('member','entry','entry_deleted','label','assignment','session','unit','change','copy','output','done')),
  after_key text NOT NULL DEFAULT '' CHECK (octet_length(after_key) <= 512),
  tie text NOT NULL DEFAULT '' CHECK (octet_length(tie) <= 64),
  session_id uuid,
  scanned bigint NOT NULL DEFAULT 0 CHECK (scanned >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,capture_id)
);
CREATE TABLE library.native_source_receipt (
  route integer NOT NULL,
  capture_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  owner_epoch integer NOT NULL,
  position bigint NOT NULL CHECK (position > 0),
  native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (route,capture_id),
  FOREIGN KEY (route,capture_id) REFERENCES library.native_source_capture(route,capture_id)
);
CREATE TABLE library.native_source_hold (
  route integer NOT NULL,
  capture_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  released boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,capture_id,hold_id),
  FOREIGN KEY (route,capture_id) REFERENCES library.native_source_receipt(route,capture_id)
);
-- Raw ranges include retained/excluded rows. Predicates never define scan exhaustion.
CREATE INDEX native_source_member_raw ON library.collection_member(route,collection_id,ordinal_key,member_id);
CREATE INDEX native_source_output_raw ON library.published_log(route,account_id,log_id);

CREATE FUNCTION library.advance_native_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; step integer; owner uuid; r integer; k text;
BEGIN
  -- Both old and new anchors are fenced. Only native key columns enter control metadata.
  -- Conservatively fence even a no-op UPDATE, without converting business payload to JSON.
  FOR step IN 1..2 LOOP
    IF step=1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    r := item.route;
    IF TG_TABLE_NAME IN ('collection','collection_member') THEN
      k := 'collection'; owner := item.collection_id;
    ELSIF TG_TABLE_NAME IN ('progress_unit','progress_change') THEN
      k := 'account';
      SELECT account_id INTO owner FROM library.progress_session
        WHERE route=r AND session_id=item.session_id;
      -- Parent deletion already fences the account, including cascading child deletion.
    ELSE
      k := 'account'; owner := item.account_id;
    END IF;
    IF owner IS NOT NULL THEN
      INSERT INTO library.native_source_fence(route,kind,owner_id,generation) VALUES(r,k,owner,1)
      ON CONFLICT (route,kind,owner_id) DO UPDATE
        SET generation=library.native_source_fence.generation+1;
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.collection
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.collection_member
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.fact_source_head
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.entry
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.entry_deleted
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.personal_label
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.label_assignment
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.progress_unit
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.progress_change
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.copy
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.published_log
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();

CREATE TRIGGER native_source_account_writer AFTER INSERT OR UPDATE OR DELETE ON access.account
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();

-- Immutable committed provenance: only the native finalization statement creates this receipt.
CREATE FUNCTION library.guard_native_source_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'native_source_receipt_immutable';
END; $$;
CREATE TRIGGER native_source_receipt_immutable BEFORE UPDATE OR DELETE ON library.native_source_receipt
  FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();

-- migrate:down
DROP TRIGGER native_source_writer ON library.fact_source_head;
DROP TRIGGER native_source_account_writer ON access.account;
DROP TRIGGER native_source_writer ON library.collection;
DROP TRIGGER native_source_writer ON library.collection_member;
DROP TRIGGER native_source_writer ON library.entry;
DROP TRIGGER native_source_writer ON library.entry_deleted;
DROP TRIGGER native_source_writer ON library.personal_label;
DROP TRIGGER native_source_writer ON library.label_assignment;
DROP TRIGGER native_source_writer ON library.progress_session;
DROP TRIGGER native_source_writer ON library.progress_unit;
DROP TRIGGER native_source_writer ON library.progress_change;
DROP TRIGGER native_source_writer ON library.copy;
DROP TRIGGER native_source_writer ON library.published_log;
DROP TABLE library.native_source_hold;
DROP TABLE library.native_source_receipt;
DROP TABLE library.native_source_capture;
DROP TABLE library.native_source_fence;
DROP FUNCTION library.guard_native_source_receipt();
DROP FUNCTION library.advance_native_source_fence();
DROP INDEX library.native_source_member_raw;
DROP INDEX library.native_source_output_raw;
