DELETE FROM content.author_item
WHERE route = :route::integer AND author_account_id = :account_id::uuid
  AND item_kind = :item_kind::text AND item_id = :item_id::uuid
RETURNING item_kind, item_id::text, source_epoch, source_position::text;
