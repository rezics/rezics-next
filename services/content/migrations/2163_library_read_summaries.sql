-- Request work follows a shelf/page or import batch, rather than recounting the
-- inventory. Backfill once; subsequent owner transactions maintain the totals.
ALTER TABLE reader.library_status_revision
  ADD COLUMN want_to_read_count bigint NOT NULL DEFAULT 0 CHECK (want_to_read_count >= 0),
  ADD COLUMN reading_count bigint NOT NULL DEFAULT 0 CHECK (reading_count >= 0),
  ADD COLUMN read_count bigint NOT NULL DEFAULT 0 CHECK (read_count >= 0);
INSERT INTO reader.library_status_revision(agent,want_to_read_count,reading_count,read_count)
SELECT agent,count(*) FILTER (WHERE status='want-to-read'),count(*) FILTER (WHERE status='reading'),
  count(*) FILTER (WHERE status='read') FROM reader.library_status GROUP BY agent
ON CONFLICT (agent) DO UPDATE SET want_to_read_count=EXCLUDED.want_to_read_count,
  reading_count=EXCLUDED.reading_count,read_count=EXCLUDED.read_count;

CREATE FUNCTION reader.advance_library_shelf_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.agent,OLD.status) IS NOT DISTINCT FROM (NEW.agent,NEW.status) THEN RETURN NULL; END IF;
  -- The existing library_status_revision trigger creates the row first.
  IF TG_OP<>'INSERT' AND OLD.status IS NOT NULL THEN
    UPDATE reader.library_status_revision SET
      want_to_read_count=want_to_read_count-(OLD.status='want-to-read')::integer,
      reading_count=reading_count-(OLD.status='reading')::integer,
      read_count=read_count-(OLD.status='read')::integer WHERE agent=OLD.agent;
  END IF;
  IF TG_OP<>'DELETE' AND NEW.status IS NOT NULL THEN
    UPDATE reader.library_status_revision SET
      want_to_read_count=want_to_read_count+(NEW.status='want-to-read')::integer,
      reading_count=reading_count+(NEW.status='reading')::integer,
      read_count=read_count+(NEW.status='read')::integer WHERE agent=NEW.agent;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER library_status_z_counts AFTER INSERT OR UPDATE OR DELETE ON reader.library_status
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_shelf_counts();

ALTER TABLE reader.library_import_file
  ADD COLUMN total_count integer NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  ADD COLUMN completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  ADD COLUMN issue_count integer NOT NULL DEFAULT 0 CHECK (issue_count >= 0);
UPDATE reader.library_import_file f SET total_count=s.total,completed_count=s.completed,issue_count=s.issues
FROM (SELECT agent,file_id,count(*)::integer AS total,count(outcome)::integer AS completed,
  count(*) FILTER (WHERE jsonb_array_length(outcome->'issues')>0)::integer AS issues
  FROM reader.library_import_source_row GROUP BY agent,file_id) s WHERE f.agent=s.agent AND f.id=s.file_id;

CREATE FUNCTION reader.advance_library_import_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.agent,OLD.file_id,OLD.outcome) IS NOT DISTINCT FROM (NEW.agent,NEW.file_id,NEW.outcome) THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' THEN
    UPDATE reader.library_import_file SET total_count=total_count-1,
      completed_count=completed_count-(OLD.outcome IS NOT NULL)::integer,
      issue_count=issue_count-coalesce((jsonb_array_length(OLD.outcome->'issues')>0)::integer,0)
      WHERE agent=OLD.agent AND id=OLD.file_id;
  END IF;
  IF TG_OP<>'DELETE' THEN
    UPDATE reader.library_import_file SET total_count=total_count+1,
      completed_count=completed_count+(NEW.outcome IS NOT NULL)::integer,
      issue_count=issue_count+coalesce((jsonb_array_length(NEW.outcome->'issues')>0)::integer,0)
      WHERE agent=NEW.agent AND id=NEW.file_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER library_import_source_row_counts AFTER INSERT OR UPDATE OR DELETE ON reader.library_import_source_row
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_import_counts();

-- The export's earliest-expiry seek must not inspect every retained upload.
CREATE INDEX library_import_agent_expiry ON reader.library_import_file(agent,expires_at);
