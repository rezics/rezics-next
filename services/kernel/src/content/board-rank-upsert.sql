WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :board_id::uuid AS board_id, :thread_id::uuid AS thread_id,
         :created_at::timestamptz AS created_at, :activity_at::timestamptz AS activity_at,
         :source_epoch::integer AS source_epoch, :source_position::bigint AS source_position,
         :source_revision_id::uuid AS source_revision_id
)
INSERT INTO content.board_thread
  (route, board_id, thread_id, created_at, last_activity_at, score, active_rank, rank_refreshed_at,
   source_epoch, source_position, source_revision_id)
SELECT route, board_id, thread_id, created_at, activity_at, 0,
       content.board_thread_active_rank(0, activity_at, statement_timestamp()),
       statement_timestamp(), source_epoch, source_position, source_revision_id
FROM input
ON CONFLICT (route, board_id, thread_id) DO UPDATE
SET source_epoch = EXCLUDED.source_epoch,
    source_position = EXCLUDED.source_position,
    source_revision_id = EXCLUDED.source_revision_id,
    last_activity_at = GREATEST(board_thread.last_activity_at, EXCLUDED.last_activity_at),
    active_rank = content.board_thread_active_rank(
      board_thread.score,
      GREATEST(board_thread.last_activity_at, EXCLUDED.last_activity_at),
      statement_timestamp()
    ),
    rank_refreshed_at = statement_timestamp()
WHERE (board_thread.source_epoch, board_thread.source_position)
    < (EXCLUDED.source_epoch, EXCLUDED.source_position)
RETURNING thread_id;
