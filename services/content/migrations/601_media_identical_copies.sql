-- An original anchor gives every future rendition a constant-cost clearance/hash
-- lookup even when a transform is derived from another rendition.
ALTER TABLE media.representation ADD COLUMN original_id uuid;
WITH RECURSIVE roots AS (
  SELECT id, id AS original_id FROM media.representation WHERE kind = 'original'
  UNION ALL SELECT p.id, r.original_id FROM media.representation p JOIN roots r ON p.source_id = r.id
) UPDATE media.representation p SET original_id = r.original_id FROM roots r WHERE p.id = r.id;
ALTER TABLE media.representation ALTER COLUMN original_id SET NOT NULL;
ALTER TABLE media.representation ADD CONSTRAINT representation_original_basis
  FOREIGN KEY (asset_id, original_id) REFERENCES media.representation(asset_id, id);
CREATE FUNCTION media.original_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.original_id IS DISTINCT FROM NEW.original_id THEN
    RAISE EXCEPTION 'immutable media original anchor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_original_immutable BEFORE UPDATE ON media.representation
  FOR EACH ROW EXECUTE FUNCTION media.original_identity_guard();
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
    NEW.original_id = NEW.id;
    NEW.clearance = 'screening'; NEW.clearance_reason = NULL;
    PERFORM pg_advisory_xact_lock(hashtextextended('media-copy:' || NEW.byte_digest, 0));
    IF EXISTS (SELECT 1 FROM media.suppressed_digest WHERE digest = NEW.byte_digest) THEN
      NEW.clearance = 'rejected'; NEW.clearance_reason = 'identical-copy-suppressed';
    END IF;
  ELSE
    SELECT original_id, clearance, clearance_reason INTO NEW.original_id, NEW.clearance, NEW.clearance_reason
      FROM media.representation WHERE id = NEW.source_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_suppressed BEFORE INSERT ON media.representation
  FOR EACH ROW EXECUTE FUNCTION media.check_suppressed_original();
-- Every read applies the original's clearance and byte marker, including future renditions.
CREATE OR REPLACE FUNCTION media.delivery_clearance(p media.representation) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM media.suppressed_digest d WHERE d.digest = o.byte_digest)
    THEN 'rejected' ELSE o.clearance END FROM media.representation o
    WHERE o.id = p.original_id
$$;
