-- migrate:up
ALTER TABLE semantic.adoption ADD CONSTRAINT adoption_selection_objects_check
  CHECK (NOT jsonb_path_exists(selection, 'strict $[*] ? (@.type() != "object")'));

-- migrate:down
ALTER TABLE semantic.adoption DROP CONSTRAINT adoption_selection_objects_check;
