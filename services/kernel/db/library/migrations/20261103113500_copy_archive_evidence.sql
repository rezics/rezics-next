-- migrate:up
CREATE TABLE library.copy_archive_upload (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK (octet_length(manifest::text) <= 131072),
  coverage jsonb NOT NULL CHECK (octet_length(coverage::text) <= 8192),
  holding_count integer NOT NULL CHECK (holding_count BETWEEN 0 AND 4096),
  expires_at timestamptz NOT NULL,
  cancelled boolean NOT NULL DEFAULT false,
  removing boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, account_id),
  UNIQUE (route, account_id, upload_id)
);
CREATE INDEX copy_archive_upload_expiry ON library.copy_archive_upload (expires_at, route, account_id);
CREATE TABLE library.copy_archive_row (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99999),
  evidence jsonb NOT NULL CHECK (octet_length(evidence::text) <= 131072),
  PRIMARY KEY (route, account_id, upload_id, ordinal),
  FOREIGN KEY (route, account_id, upload_id)
    REFERENCES library.copy_archive_upload (route, account_id, upload_id)
);

-- migrate:down
DROP TABLE library.copy_archive_row;
DROP TABLE library.copy_archive_upload;
