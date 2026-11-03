-- migrate:up
-- One bounded control record per owner. Export facts are delivered directly, never retained here.
CREATE TABLE library.library_export (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  export_id uuid NOT NULL,
  generation bigint NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('collecting','ready','stale','cancelled','expired','limit')),
  PRIMARY KEY (route, account_id),
  CHECK (route = (get_byte(uuid_send(account_id),10)*256 + get_byte(uuid_send(account_id),11))),
  CHECK (expires_at = created_at + interval '15 minutes')
);
-- Collection changes also invalidate the whole personal export, including occurrence-only changes.
CREATE FUNCTION library.advance_export_collection_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; owner uuid; step integer;
BEGIN
  FOR step IN 1..2 LOOP
    IF step=1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    IF TG_TABLE_NAME='collection' THEN owner := item.curator_account_id;
    ELSE
      SELECT curator_account_id INTO owner FROM library.collection
        WHERE route=item.route AND collection_id=item.collection_id;
    END IF;
    IF owner IS NOT NULL THEN
      INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id)
        VALUES(item.route,'account',owner,1,owner)
      ON CONFLICT (route,kind,owner_id) DO UPDATE
        SET generation=library.native_source_fence.generation+1;
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;
CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.collection
  FOR EACH ROW EXECUTE FUNCTION library.advance_export_collection_fence();
CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.collection_member
  FOR EACH ROW EXECUTE FUNCTION library.advance_export_collection_fence();
CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.collection_pins
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE INDEX library_export_copy_seek ON library.copy(route,account_id,copy_id) WHERE deletion_id IS NULL;

CREATE INDEX library_export_unit_seek ON library.progress_unit(route,session_id,unit_id COLLATE "C");

-- migrate:down
DROP INDEX library.library_export_unit_seek;
DROP INDEX library.library_export_copy_seek;
DROP TRIGGER export_owner_fence ON library.collection_pins;
DROP TRIGGER export_owner_fence ON library.collection_member;
DROP TRIGGER export_owner_fence ON library.collection;
DROP FUNCTION library.advance_export_collection_fence();
DROP TABLE library.library_export;
