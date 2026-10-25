-- migrate:up
ALTER TABLE content.board
  ADD CONSTRAINT board_title_size CHECK (char_length(title) BETWEEN 1 AND 1024);

ALTER TABLE content.thread
  ADD CONSTRAINT thread_title_size CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 1024);

ALTER TABLE content.revision
  ADD CONSTRAINT revision_licence_size CHECK (
    char_length(licence) BETWEEN 1 AND 128
    AND (licence ~ '^[A-Za-z0-9.+-]+$' OR licence ~ '^LicenseRef-[A-Za-z0-9.-]+$')
  );

ALTER TABLE content.imported_field
  ADD CONSTRAINT imported_field_metadata_size CHECK (
    octet_length(convert_to(source::text, 'UTF8')) <= 65536
    AND octet_length(convert_to(rights::text, 'UTF8')) <= 8192
    AND char_length(rights ->> 'license') BETWEEN 1 AND 128
    AND (rights ->> 'license' ~ '^[A-Za-z0-9.+-]+$' OR rights ->> 'license' ~ '^LicenseRef-[A-Za-z0-9.-]+$')
    AND char_length(rights ->> 'attribution') BETWEEN 1 AND 1024
    AND jsonb_typeof(rights -> 'obligations') = 'array'
  );

ALTER TABLE content.media
  ADD CONSTRAINT media_cover_metadata_size CHECK (
    purpose <> 'cover' OR (
      char_length(source_url) BETWEEN 1 AND 2048
      AND octet_length(convert_to(credit::text, 'UTF8')) <= 8192
      AND char_length(credit ->> 'rightsHolder') BETWEEN 1 AND 1024
      AND char_length(credit -> 'via' ->> 'name') BETWEEN 1 AND 1024
      AND char_length(credit -> 'via' ->> 'url') BETWEEN 1 AND 1024
      AND char_length(credit ->> 'license') BETWEEN 1 AND 128
      AND (credit ->> 'license' ~ '^[A-Za-z0-9.+-]+$' OR credit ->> 'license' ~ '^LicenseRef-[A-Za-z0-9.-]+$')
      AND octet_length(convert_to(provenance::text, 'UTF8')) <= 65536
      AND jsonb_array_length(provenance -> 'references') BETWEEN 1 AND 128
    )
  );

-- migrate:down
ALTER TABLE content.media DROP CONSTRAINT media_cover_metadata_size;
ALTER TABLE content.imported_field DROP CONSTRAINT imported_field_metadata_size;
ALTER TABLE content.revision DROP CONSTRAINT revision_licence_size;
ALTER TABLE content.thread DROP CONSTRAINT thread_title_size;
ALTER TABLE content.board DROP CONSTRAINT board_title_size;
