-- migrate:up
ALTER TABLE access.account_preferences
  ADD COLUMN editor jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(editor) = 'object' AND octet_length(editor::text) <= 16384);

-- migrate:down
ALTER TABLE access.account_preferences DROP COLUMN editor;
