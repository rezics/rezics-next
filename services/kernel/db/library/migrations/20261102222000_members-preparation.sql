-- migrate:up
-- The native reservation/result tables already exist. Idle maintenance seeks a
-- bounded route-local expiry frontier without visiting every owner or result.
CREATE INDEX members_preparation_expiry
  ON library.members_preparation(route, last_read_at, owner_account_id, collection_id, episode_id)
  WHERE state = 'live';

-- migrate:down
DROP INDEX library.members_preparation_expiry;
