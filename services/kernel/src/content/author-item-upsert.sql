INSERT INTO content.author_item AS indexed
  (route, author_account_id, item_kind, item_id, thread_id, thread_kind, created_at, source_epoch, source_position,
   draft_state, draft_revision_id, draft_language)
VALUES (:route::integer, :author_account_id::uuid, :item_kind::text, :item_id::uuid, :thread_id::uuid,
  :thread_kind::text, :created_at::timestamptz, :source_epoch::integer, :source_position::bigint,
  :draft_state::text, :draft_revision_id::nullable(uuid), :draft_language::nullable(text))
ON CONFLICT (route, author_account_id, item_kind, item_id) DO UPDATE
SET source_epoch = EXCLUDED.source_epoch, source_position = EXCLUDED.source_position,
    draft_state = EXCLUDED.draft_state, draft_revision_id = EXCLUDED.draft_revision_id,
    draft_language = EXCLUDED.draft_language
WHERE ROW(indexed.source_epoch, indexed.source_position) < ROW(EXCLUDED.source_epoch, EXCLUDED.source_position)
RETURNING item_id;
