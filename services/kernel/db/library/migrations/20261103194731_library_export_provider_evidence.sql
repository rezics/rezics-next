-- migrate:up
ALTER TABLE library.library_export DROP CONSTRAINT library_export_format_version_check;
ALTER TABLE library.library_export ADD CONSTRAINT library_export_format_version_check CHECK(format_version IN (1,2,3));

-- Source-owned parsed row index: no XML, decisions or export artifact. Parent removal owns cleanup.
-- Building this once avoids detoasting/parsing the entire retained VNDB array on every export page.
CREATE TABLE library.vndb_import_row (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 4999),
  evidence jsonb NOT NULL,
  PRIMARY KEY(route,account_id,upload_id,ordinal),
  FOREIGN KEY(route,account_id,upload_id) REFERENCES library.vndb_import(route,account_id,upload_id) ON DELETE CASCADE
);
INSERT INTO library.vndb_import_row
  SELECT route,account_id,upload_id,(ordinality-1)::integer,evidence
  FROM library.vndb_import CROSS JOIN LATERAL jsonb_array_elements(rows) WITH ORDINALITY AS r(evidence,ordinality);
CREATE FUNCTION library.index_vndb_import_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.rows IS NOT DISTINCT FROM OLD.rows THEN RETURN NULL; END IF;
  DELETE FROM library.vndb_import_row WHERE route=NEW.route AND account_id=NEW.account_id AND upload_id=NEW.upload_id;
  INSERT INTO library.vndb_import_row
    SELECT NEW.route,NEW.account_id,NEW.upload_id,(ordinality-1)::integer,evidence
    FROM jsonb_array_elements(NEW.rows) WITH ORDINALITY AS r(evidence,ordinality);
  RETURN NULL;
END; $$;
CREATE TRIGGER index_parsed_rows AFTER INSERT OR UPDATE OF rows ON library.vndb_import
  FOR EACH ROW EXECUTE FUNCTION library.index_vndb_import_rows();

-- Header reads must not parse the retained raw document; metadata is projected at source write time.
ALTER TABLE library.list_import_anilist
  ADD COLUMN export_source jsonb GENERATED ALWAYS AS (CASE WHEN ordinal>=0 THEN payload->'source' END) STORED,
  ADD COLUMN export_score_format text GENERATED ALWAYS AS (CASE WHEN ordinal=-1 THEN payload->>'scoreFormat' END) STORED,
  ADD COLUMN export_cancelled boolean GENERATED ALWAYS AS (CASE WHEN ordinal=-1 THEN (payload->>'cancelled')::boolean END) STORED,
  ADD COLUMN export_count integer GENERATED ALWAYS AS (CASE WHEN ordinal=-1 THEN (payload->>'count')::integer END) STORED;
CREATE INDEX library_export_anilist_header ON library.list_import_anilist(route,account_id,import_id) WHERE ordinal=-1;
CREATE INDEX library_export_vndb_expiry ON library.vndb_import(route,account_id,expires_at);
CREATE INDEX library_export_mal_expiry ON library.list_import_mal(route,account_id,expires_at);

CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.vndb_import
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.vndb_import_row
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.list_import_anilist
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();

-- migrate:down
-- Forward only: captures and their cursor epochs must retain their declared format meaning.
