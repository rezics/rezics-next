-- migrate:up
ALTER TABLE content.media
  DROP CONSTRAINT media_purpose_check,
  ADD CONSTRAINT media_purpose_check CHECK (purpose IN ('post-image', 'cover', 'avatar')),
  ADD CONSTRAINT media_avatar_owner_check CHECK (
    purpose <> 'avatar' OR (container_id = uploader_id AND source_url IS NULL AND credit IS NULL AND provenance IS NULL)
  );

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Avatar media storage migration is forward only';
END $$;
