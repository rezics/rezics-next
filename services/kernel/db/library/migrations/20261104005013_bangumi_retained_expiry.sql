-- migrate:up
-- An upload has one absolute lifetime; reading or reviewing it never moves this deadline.
ALTER TABLE library.bangumi_upload
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days');

CREATE INDEX bangumi_upload_expiry
  ON library.bangumi_upload (expires_at, route, account_id, upload_id);

-- migrate:down
DROP INDEX library.bangumi_upload_expiry;
ALTER TABLE library.bangumi_upload DROP COLUMN expires_at;
