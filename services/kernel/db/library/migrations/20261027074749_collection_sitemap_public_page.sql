-- migrate:up
-- The included updated_at lets an index-only scan serve a page; the curator indexes would otherwise read a whole route.
CREATE INDEX collection_sitemap_public_page ON library.collection
  (route, collection_id) INCLUDE (updated_at)
  WHERE state = 'active' AND visibility = 'public';

-- migrate:down
-- Forward only: sitemap candidate discovery must retain its bounded partition seek.
