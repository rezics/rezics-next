-- migrate:up
ALTER TABLE auth_client ADD COLUMN display_name text;

-- migrate:down
ALTER TABLE auth_client DROP COLUMN display_name;
