-- Keep a collection result (zero or one rows) for an exact revision lookup.
SELECT route, thread_id, post_id, revision_id, body, body_sha256, search_text,
       licence, subject_ids, board_id, availability, recorded_transaction_id, recorded_at
FROM content.revision
WHERE route = :route::integer AND thread_id = :thread_id::uuid
  AND post_id = :post_id::uuid AND revision_id = ANY (ARRAY[:revision_id::uuid]);
