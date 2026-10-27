-- migrate:up
ALTER TABLE access.account_preferences
  ADD COLUMN shelf jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(shelf) = 'object' AND octet_length(shelf::text) <= 16384);

-- migrate:down
ALTER TABLE access.account_preferences DROP COLUMN shelf;
