-- migrate:up
ALTER TABLE library.library_export
  ALTER COLUMN format_version SET DEFAULT 3,
  DROP CONSTRAINT library_export_format_version_check,
  ADD CONSTRAINT library_export_format_version_check CHECK (format_version IN (1, 2, 3));

-- migrate:down
-- Forward only: version 3 captures must not be reinterpreted as an older format.
