-- migrate:up
ALTER TABLE content.media
  ALTER COLUMN media_type DROP NOT NULL,
  ALTER COLUMN byte_count DROP NOT NULL,
  DROP CONSTRAINT media_purpose_check,
  DROP CONSTRAINT media_check4,
  ADD COLUMN source_url text,
  ADD COLUMN credit jsonb,
  ADD COLUMN provenance jsonb,
  ADD COLUMN taken_down boolean NOT NULL DEFAULT false,
  ADD COLUMN security_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT media_purpose_check CHECK (purpose IN ('post-image', 'cover')),
  ADD CONSTRAINT media_security_revision_check CHECK (security_revision >= 0),
  ADD CONSTRAINT media_cover_provenance_check CHECK (
    purpose <> 'cover' OR (
      source_url IS NOT NULL AND source_url ~ '^https://[^[:space:]]+$'
      AND char_length(source_url) <= 2048
      AND credit IS NOT NULL AND jsonb_typeof(credit) = 'object'
      AND jsonb_typeof(credit -> 'rightsHolder') = 'string'
      AND char_length(credit ->> 'rightsHolder') BETWEEN 1 AND 1024
      AND jsonb_typeof(credit -> 'via') = 'object'
      AND jsonb_typeof(credit -> 'via' -> 'name') = 'string'
      AND char_length(credit -> 'via' ->> 'name') BETWEEN 1 AND 1024
      AND (credit -> 'via' ->> 'url') ~ '^https://[^[:space:]]+$'
      AND jsonb_typeof(credit -> 'license') = 'string'
      AND char_length(credit ->> 'license') > 0
      AND jsonb_typeof(credit -> 'obligations') = 'array'
      AND provenance IS NOT NULL AND jsonb_typeof(provenance) = 'object'
      AND (provenance ->> 'source') ~ '^[a-z][a-z0-9_-]{0,31}$'
      AND char_length(provenance ->> 'external_id') > 0
      AND char_length(provenance ->> 'record_revision') > 0
      AND (provenance ->> 'digest') ~ '^[0-9a-f]{64}$'
      AND char_length(provenance ->> 'converter_revision') > 0
      AND (provenance ->> 'field_group') = 'cover'
      AND jsonb_typeof(provenance -> 'references') = 'array'
      AND jsonb_array_length(provenance -> 'references') BETWEEN 1 AND 128
    ) IS TRUE
  ),
  ADD CONSTRAINT media_declared_measurements_check CHECK (
    purpose = 'cover' OR (byte_count IS NOT NULL AND media_type IS NOT NULL)
  ),
  ADD CONSTRAINT media_measurements_check CHECK ((
    (state = 'reserved' AND actual_byte_count IS NULL AND sha256 IS NULL
      AND decision IS NULL AND claimed_at IS NULL)
    OR (state IN ('uploaded', 'available', 'rejected')
      AND byte_count IS NOT NULL AND media_type IS NOT NULL
      AND actual_byte_count IS NOT NULL AND actual_byte_count = byte_count
      AND sha256 IS NOT NULL
      AND ((state = 'uploaded' AND decision IS NULL AND claimed_at IS NULL)
        OR (state = 'available' AND decision IS NULL)
        OR (state = 'rejected' AND decision IS NOT NULL AND claimed_at IS NULL)))
    OR (purpose = 'cover' AND state = 'rejected'
      AND byte_count IS NULL AND media_type IS NULL
      AND actual_byte_count IS NULL AND sha256 IS NULL AND declared_sha256 IS NULL
      AND decision IS NOT NULL AND claimed_at IS NULL)
  ) IS TRUE);

CREATE INDEX media_cover_reference_idx ON content.media (route, media_id)
  WHERE purpose = 'cover' AND state = 'available'
    AND NOT erased AND NOT collection_pending AND NOT taken_down;

CREATE FUNCTION content.guard_media_security() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.security_revision < OLD.security_revision
     OR (NEW.taken_down IS DISTINCT FROM OLD.taken_down
         AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Media takedown changes require an increasing security revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_security_guard BEFORE UPDATE ON content.media
FOR EACH ROW EXECUTE FUNCTION content.guard_media_security();

-- migrate:down
-- A rollback cannot discard cover provenance or restore website-only nullability losslessly.
DO $$ BEGIN
  RAISE EXCEPTION 'Cover media storage migration is forward only';
END $$;
