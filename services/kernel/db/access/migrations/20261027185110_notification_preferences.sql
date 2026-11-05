-- migrate:up
ALTER TABLE access.account_preferences
  ADD COLUMN notifications jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(notifications) = 'object' AND octet_length(notifications::text) <= 2048);

-- migrate:down
ALTER TABLE access.account_preferences DROP COLUMN notifications;
