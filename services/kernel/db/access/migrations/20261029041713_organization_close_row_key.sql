-- migrate:up
ALTER TABLE access.organization_member
  ADD COLUMN row_key uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX organization_member_row_key
  ON access.organization_member (route, organization_id, row_key);

-- Every earlier page removed its rows atomically with its checkpoint. Restarting
-- in row-key order therefore visits only remaining rows, without translation.
ALTER TABLE access.organization_close
  DROP COLUMN cursor_member,
  DROP COLUMN cursor_valid,
  ADD COLUMN cursor_row_key uuid;

-- migrate:down
ALTER TABLE access.organization_close
  DROP COLUMN cursor_row_key,
  ADD COLUMN cursor_member uuid,
  ADD COLUMN cursor_valid tstzrange;
DROP INDEX access.organization_member_row_key;
ALTER TABLE access.organization_member DROP COLUMN row_key;
