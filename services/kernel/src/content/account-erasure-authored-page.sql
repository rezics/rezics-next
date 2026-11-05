WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_kind::text AS after_kind, :after_id::uuid AS after_id, :resume::boolean AS resume
)
SELECT a.item_kind, a.item_id::text, a.thread_id::text, a.source_epoch, a.source_position::text
FROM content.author_item a CROSS JOIN input i
WHERE a.route = i.route AND a.author_account_id = i.account_id
  AND (a.item_kind, a.item_id) >= (i.after_kind, i.after_id)
  AND (i.resume OR (a.item_kind, a.item_id) > (i.after_kind, i.after_id))
ORDER BY a.item_kind, a.item_id
LIMIT 50;
