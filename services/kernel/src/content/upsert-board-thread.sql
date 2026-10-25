INSERT INTO content.board_thread
  (route, board_id, thread_id, created_at, source_epoch, source_position, source_revision_id)
VALUES (:route::integer, :board_id::uuid, :thread_id::uuid, :created_at::timestamptz,
        :source_epoch::integer, :source_position::bigint, :source_revision_id::uuid)
ON CONFLICT (route, board_id, thread_id) DO UPDATE
SET source_epoch = EXCLUDED.source_epoch,
    source_position = EXCLUDED.source_position,
    source_revision_id = EXCLUDED.source_revision_id
WHERE (board_thread.source_epoch, board_thread.source_position)
    < (EXCLUDED.source_epoch, EXCLUDED.source_position)
RETURNING thread_id;
