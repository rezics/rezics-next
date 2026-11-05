-- migrate:up
CREATE INDEX follow_account_kind_page
  ON library.follow (route, account_id, target_type, state, updated_at DESC, target_id);

-- migrate:down
DROP INDEX library.follow_account_kind_page;
