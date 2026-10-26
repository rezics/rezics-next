INSERT INTO content.author_item AS indexed
  (route, author_account_id, item_kind, item_id, thread_id, thread_kind, created_at, source_epoch, source_position)
VALUES (:route::integer, :author_account_id::uuid, :item_kind::text, :item_id::uuid, :thread_id::uuid,
  :thread_kind::text, :created_at::timestamptz, :source_epoch::integer, :source_position::bigint)
ON CONFLICT (route, author_account_id, item_kind, item_id) DO UPDATE
SET source_epoch = EXCLUDED.source_epoch, source_position = EXCLUDED.source_position
WHERE ROW(indexed.source_epoch, indexed.source_position) < ROW(EXCLUDED.source_epoch, EXCLUDED.source_position)
RETURNING item_id;
