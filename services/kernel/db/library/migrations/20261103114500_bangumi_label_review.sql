-- migrate:up
-- Same retained row and cleanup owner; native label identities are never children of an upload.
ALTER TABLE library.bangumi_upload_row ADD COLUMN labels jsonb,
  ADD COLUMN label_creations integer NOT NULL DEFAULT 0 CHECK (label_creations BETWEEN 0 AND 16),
  ADD COLUMN label_assignments integer NOT NULL DEFAULT 0 CHECK (label_assignments BETWEEN 0 AND 16);
ALTER TABLE library.bangumi_upload_row ADD CONSTRAINT bangumi_label_review_bytes
  CHECK (labels IS NULL OR octet_length(labels::text) <= 32768);
-- migrate:down
ALTER TABLE library.bangumi_upload_row DROP COLUMN labels, DROP COLUMN label_creations, DROP COLUMN label_assignments;
