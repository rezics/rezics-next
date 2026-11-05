-- migrate:up
ALTER TABLE access.account
  ADD COLUMN links jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 5);

-- migrate:down
ALTER TABLE access.account DROP COLUMN links;
