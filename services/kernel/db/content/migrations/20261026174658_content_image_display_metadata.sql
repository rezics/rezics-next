-- migrate:up
ALTER TABLE content.media
  ADD COLUMN width integer,
  ADD COLUMN height integer,
  ADD COLUMN thumbhash bytea,
  ADD COLUMN average_color text;

ALTER TABLE content.media
  ADD CONSTRAINT media_image_display_metadata_check CHECK (
    purpose <> 'cover' OR state <> 'available' OR (
      width IS NOT NULL AND width > 0
      AND height IS NOT NULL AND height > 0
      AND thumbhash IS NOT NULL AND octet_length(thumbhash) <= 32
      AND average_color IS NOT NULL AND average_color ~ '^#[0-9a-f]{6}$'
    )
  ) NOT VALID;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Published image display metadata is durable';
END $$;
