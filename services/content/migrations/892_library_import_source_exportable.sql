-- A library export page is a digest keyset. The exportable predicate used to be
-- applied after a lateral join, so a page walked every later source until it
-- had filled. Most sources are not exportable, and that made a whole export
-- quadratic. The marker keeps the keyset on this partial index instead.
--
-- exportable is true when the source kind is source or retained, private_extras
-- is not empty, or any of its rows needs an archive. The writes that change
-- that fact recompute it in the same transaction:
--   LibraryFileStore.create inserts the source and its row (a row with no
--     outcome still needs an archive);
--   LibraryFileStore.resolve updates resolution (a private choice needs an archive);
--   LibraryFileStore.complete updates outcome (a clean outcome can clear it);
--   deleteLibraryUploads and eraseLibraryImportsForPrincipals delete rows and
--     sources.
-- File expiry is time-dependent and stays out of the marker. The export applies
-- it to the already limited page, which may then return fewer rows than the limit.
ALTER TABLE reader.library_import_source
  ADD COLUMN exportable boolean NOT NULL DEFAULT false;

CREATE FUNCTION reader.library_import_source_exportable(p_agent text, p_digest text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce((
    SELECT s.source->>'kind' IN ('source','retained')
      OR s.private_extras <> '{}'::jsonb
      OR EXISTS (
        SELECT 1 FROM reader.library_import_source_row r
        WHERE r.agent = s.agent AND r.source_digest = s.digest AND r.archive_needed
      )
    FROM reader.library_import_source s
    WHERE s.agent = p_agent AND s.digest = p_digest
  ), false)
$$;

CREATE FUNCTION reader.refresh_library_import_source_exportable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_agent text;
  source_digest text;
BEGIN
  IF TG_TABLE_NAME = 'library_import_source' THEN
    source_agent := NEW.agent;
    source_digest := NEW.digest;
  ELSE
    source_agent := COALESCE(NEW.agent, OLD.agent);
    source_digest := COALESCE(NEW.source_digest, OLD.source_digest);
  END IF;
  UPDATE reader.library_import_source s
  SET exportable = reader.library_import_source_exportable(s.agent, s.digest)
  WHERE s.agent = source_agent AND s.digest = source_digest
    AND s.exportable IS DISTINCT FROM reader.library_import_source_exportable(s.agent, s.digest);
  -- PL/pgSQL does not skip the rest of an AND, and a source row has no source_digest.
  IF TG_TABLE_NAME = 'library_import_source_row' THEN
    IF TG_OP = 'UPDATE' AND (OLD.agent, OLD.source_digest) IS DISTINCT FROM (NEW.agent, NEW.source_digest) THEN
      UPDATE reader.library_import_source s
      SET exportable = reader.library_import_source_exportable(s.agent, s.digest)
      WHERE s.agent = OLD.agent AND s.digest = OLD.source_digest
        AND s.exportable IS DISTINCT FROM reader.library_import_source_exportable(s.agent, s.digest);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER library_import_source_exportable_write
  AFTER INSERT OR UPDATE OF source ON reader.library_import_source
  FOR EACH ROW EXECUTE FUNCTION reader.refresh_library_import_source_exportable();
CREATE TRIGGER library_import_source_row_exportable
  AFTER INSERT OR UPDATE OR DELETE ON reader.library_import_source_row
  FOR EACH ROW EXECUTE FUNCTION reader.refresh_library_import_source_exportable();

UPDATE reader.library_import_source
SET exportable = reader.library_import_source_exportable(agent, digest)
WHERE exportable IS DISTINCT FROM reader.library_import_source_exportable(agent, digest);

CREATE INDEX library_import_source_exportable
  ON reader.library_import_source (agent, digest)
  WHERE exportable;
