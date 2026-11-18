-- migrate:up
CREATE INDEX entry_personal_live_annotation_owner
  ON library.entry_personal_fact (route, account_id)
  WHERE note IS NOT NULL OR priority IS NOT NULL;

-- migrate:down
DROP INDEX library.entry_personal_live_annotation_owner;
