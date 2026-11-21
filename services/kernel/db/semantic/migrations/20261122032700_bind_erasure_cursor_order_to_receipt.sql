-- migrate:up
ALTER TABLE semantic.erasure_source_page ADD COLUMN numeric_cursor_id uuid;
ALTER TABLE semantic.erasure_source_terminal ADD COLUMN numeric_cursor_id uuid;

-- migrate:down
ALTER TABLE semantic.erasure_source_terminal DROP COLUMN numeric_cursor_id;
ALTER TABLE semantic.erasure_source_page DROP COLUMN numeric_cursor_id;
