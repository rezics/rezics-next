-- migrate:up
CREATE INDEX thread_review_discovery_page_idx
  ON content.thread (route, thread_id)
  WHERE kind = 'review' AND review_live AND availability = 'available' AND visibility = 'published';

-- migrate:down
DROP INDEX content.thread_review_discovery_page_idx;
