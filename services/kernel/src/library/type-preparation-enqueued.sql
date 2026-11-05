UPDATE library.type_preparation_progress SET enqueue_pending = false
WHERE route = :route::integer AND account_id = :account_id::uuid AND preparation_id = :preparation_id::uuid
  AND state = 'pending' AND chunk = :chunk::bigint AND byte_offset = :offset::bigint;
