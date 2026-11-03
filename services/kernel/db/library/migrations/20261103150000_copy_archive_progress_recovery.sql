-- migrate:up
ALTER TABLE library.copy_archive_upload
  ADD COLUMN progress_count integer NOT NULL DEFAULT 0 CHECK (progress_count BETWEEN 0 AND 100000),
  ADD COLUMN review_count integer NOT NULL DEFAULT 0 CHECK (review_count BETWEEN 0 AND 4096),
  ADD COLUMN review_bytes integer NOT NULL DEFAULT 0 CHECK (review_bytes BETWEEN 0 AND 33554432);

ALTER TABLE library.copy_archive_row
  ADD COLUMN section text NOT NULL DEFAULT 'holdings',
  ADD COLUMN source_session_id uuid,
  ADD COLUMN source_unit_id text,
  ADD CONSTRAINT copy_archive_row_section_check CHECK (section IN ('holdings', 'sessions', 'units')),
  ADD CONSTRAINT copy_archive_row_source_check CHECK (
    (section = 'holdings' AND source_session_id IS NULL AND source_unit_id IS NULL) OR
    (section = 'sessions' AND source_session_id IS NOT NULL AND source_unit_id IS NULL) OR
    (section = 'units' AND source_session_id IS NOT NULL AND source_unit_id IS NOT NULL)
  );

CREATE INDEX copy_archive_row_section_page
  ON library.copy_archive_row (route, account_id, upload_id, section, ordinal);
CREATE INDEX copy_archive_row_session_page
  ON library.copy_archive_row (route, account_id, upload_id, source_session_id, section, ordinal);
CREATE INDEX copy_archive_row_unit_lookup
  ON library.copy_archive_row (route, account_id, upload_id, source_session_id, source_unit_id)
  WHERE section = 'units';

CREATE TABLE library.copy_archive_progress_review (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  review_id uuid NOT NULL,
  source_session_id uuid NOT NULL,
  source_ordinal integer NOT NULL CHECK (source_ordinal BETWEEN 0 AND 99999),
  subject_id uuid NOT NULL,
  binding jsonb NOT NULL CHECK (octet_length(binding::text) <= 8192),
  request_key_hash bytea NOT NULL CHECK (octet_length(request_key_hash) = 32),
  input_digest bytea NOT NULL CHECK (octet_length(input_digest) = 32),
  evidence jsonb NOT NULL CHECK (octet_length(evidence::text) <= 32768),
  evidence_bytes integer NOT NULL CHECK (evidence_bytes BETWEEN 0 AND 32768),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (route, account_id, upload_id, review_id),
  UNIQUE (route, account_id, upload_id, request_key_hash),
  FOREIGN KEY (route, account_id, upload_id)
    REFERENCES library.copy_archive_upload (route, account_id, upload_id)
);
CREATE INDEX copy_archive_progress_review_occurrence
  ON library.copy_archive_progress_review (route, account_id, upload_id, source_session_id, created_at DESC);

CREATE TABLE library.copy_archive_progress_apply (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  review_id uuid NOT NULL,
  request_key_hash bytea NOT NULL CHECK (octet_length(request_key_hash) = 32),
  state text NOT NULL CHECK (state IN ('applying', 'partial', 'applied', 'stale', 'failed')),
  next_step integer NOT NULL DEFAULT 0 CHECK (next_step BETWEEN 0 AND 40),
  active_step integer CHECK (active_step BETWEEN 0 AND 39),
  session_id uuid,
  error_code text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (route, account_id, upload_id, review_id),
  FOREIGN KEY (route, account_id, upload_id, review_id)
    REFERENCES library.copy_archive_progress_review (route, account_id, upload_id, review_id)
);

-- migrate:down
DROP TABLE library.copy_archive_progress_apply;
DROP TABLE library.copy_archive_progress_review;
DROP INDEX library.copy_archive_row_unit_lookup;
DROP INDEX library.copy_archive_row_session_page;
DROP INDEX library.copy_archive_row_section_page;
ALTER TABLE library.copy_archive_row
  DROP CONSTRAINT copy_archive_row_source_check,
  DROP CONSTRAINT copy_archive_row_section_check,
  DROP COLUMN source_unit_id,
  DROP COLUMN source_session_id,
  DROP COLUMN section;
ALTER TABLE library.copy_archive_upload
  DROP COLUMN review_bytes,
  DROP COLUMN review_count,
  DROP COLUMN progress_count;
