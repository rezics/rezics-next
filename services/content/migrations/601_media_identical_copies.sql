CREATE INDEX representation_original_digest ON media.representation (byte_digest, asset_id)
  WHERE kind = 'original';
-- This marker denies delivery immediately, while bounded batches advance asset
-- moderation histories. It also closes the race with concurrent activation.
CREATE TABLE media.suppressed_digest (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER suppressed_digest_immutable BEFORE UPDATE OR DELETE ON media.suppressed_digest
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE FUNCTION media.check_suppressed_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'original' THEN
    NEW.clearance = 'screening'; NEW.clearance_reason = NULL;
    PERFORM pg_advisory_xact_lock(hashtextextended('media-copy:' || NEW.byte_digest, 0));
    IF EXISTS (SELECT 1 FROM media.suppressed_digest WHERE digest = NEW.byte_digest) THEN
      NEW.clearance = 'rejected'; NEW.clearance_reason = 'identical-copy-suppressed';
    END IF;
  ELSE
    SELECT clearance, clearance_reason INTO NEW.clearance, NEW.clearance_reason
      FROM media.representation WHERE id = NEW.source_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_suppressed BEFORE INSERT ON media.representation
  FOR EACH ROW EXECUTE FUNCTION media.check_suppressed_original();
-- Each delivery resolves its original directly; nested rendition sources fail closed.
-- No rendition producer runs yet; future transforms must use an original source.
CREATE OR REPLACE FUNCTION media.delivery_clearance(p media.representation) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM media.suppressed_digest d WHERE d.digest = o.byte_digest)
    THEN 'rejected' ELSE o.clearance END FROM media.representation o
    WHERE o.id = CASE WHEN p.kind = 'original' THEN p.id ELSE p.source_id END
      AND o.kind = 'original'
$$;
