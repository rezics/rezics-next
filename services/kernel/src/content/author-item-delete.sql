DELETE FROM content.author_item
WHERE route = :route::integer AND author_account_id = :author_account_id::uuid
  AND item_kind = 'post' AND item_id = :item_id::uuid
  AND ROW(source_epoch, source_position) < ROW(:source_epoch::integer, :source_position::bigint)
RETURNING item_id;
