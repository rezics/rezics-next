-- migrate:up
DROP INDEX content.author_item_page_idx;
CREATE INDEX author_item_page_idx
  ON content.author_item (route, author_account_id, item_kind, thread_kind, created_at DESC, item_id);
-- Replies span thread kinds, so their creation-order seek needs its own range.
CREATE INDEX author_item_post_page_idx
  ON content.author_item (route, author_account_id, created_at DESC, item_id)
  WHERE item_kind = 'post';

-- migrate:down
-- Forward only: profile read indexes preserve bounded candidate pages.
