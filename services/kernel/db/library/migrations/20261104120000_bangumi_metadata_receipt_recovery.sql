-- Keep only opaque native receipt linkage for one bounded day after source expiry.
-- migrate:up
ALTER TABLE library.bangumi_upload
  ADD COLUMN recovery_until timestamptz;

DROP INDEX bangumi_upload_expiry;
CREATE INDEX bangumi_upload_expiry
  ON library.bangumi_upload (expires_at, route, account_id, upload_id)
  WHERE recovery_until IS NULL;

CREATE INDEX bangumi_upload_recovery_expiry
  ON library.bangumi_upload (recovery_until, route, account_id, upload_id)
  WHERE recovery_until IS NOT NULL;

-- migrate:down
DROP INDEX bangumi_upload_recovery_expiry;
DROP INDEX bangumi_upload_expiry;
ALTER TABLE library.bangumi_upload DROP COLUMN recovery_until;
CREATE INDEX bangumi_upload_expiry
  ON library.bangumi_upload (expires_at, route, account_id, upload_id);
