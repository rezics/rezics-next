-- migrate:up
CREATE INDEX collection_curator_page ON library.collection
  (route, curator_account_id, updated_at DESC, collection_id DESC)
  WHERE state = 'active';

CREATE INDEX collection_curator_public_page ON library.collection
  (route, curator_account_id, updated_at DESC, collection_id DESC)
  WHERE state = 'active' AND visibility = 'public';

-- migrate:down
-- Forward only: curator Collection pages must retain their bounded reads.
