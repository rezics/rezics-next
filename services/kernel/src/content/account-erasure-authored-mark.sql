-- The account-partition obligation was proved before entering this partition.
-- Keep its local, irreversible authority beside the post for the revision guard.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :item_kind::text AS item_kind, :item_id::uuid AS item_id
)
UPDATE content.post p SET author_erased = true
FROM input i
WHERE p.route = i.route AND p.author_account_id = i.account_id
  AND p.post_id = CASE WHEN i.item_kind = 'post' THEN i.item_id ELSE (
    SELECT t.first_post_id FROM content.thread t WHERE t.route = i.route AND t.thread_id = i.item_id
  ) END
  AND p.availability = 'available' AND p.visibility = 'published' AND NOT p.author_erased
RETURNING p.post_id;
