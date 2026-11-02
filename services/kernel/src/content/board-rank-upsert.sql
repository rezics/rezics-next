WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :board_id::uuid AS board_id, :thread_id::uuid AS thread_id,
         :created_at::timestamptz AS created_at, :activity_at::timestamptz AS activity_at,
         :source_epoch::integer AS source_epoch, :source_position::bigint AS source_position,
         :source_revision_id::uuid AS source_revision_id
)
INSERT INTO content.board_thread
  (route, board_id, thread_id, created_at, last_activity_at, score, active_rank, hot_rank, rank_refreshed_at,
   source_epoch, source_position, source_revision_id)
SELECT route, board_id, thread_id, created_at, activity_at, 0,
       content.board_thread_active_rank(0, activity_at, statement_timestamp()),
       content.board_thread_active_rank(0, created_at, statement_timestamp()),
       statement_timestamp(), source_epoch, source_position, source_revision_id
FROM input
ON CONFLICT (route, board_id, thread_id) DO UPDATE
SET source_epoch = GREATEST(board_thread.source_epoch, EXCLUDED.source_epoch),
    source_position = CASE WHEN board_thread.source_epoch > EXCLUDED.source_epoch
      THEN board_thread.source_position
      WHEN board_thread.source_epoch < EXCLUDED.source_epoch THEN EXCLUDED.source_position
      ELSE GREATEST(board_thread.source_position, EXCLUDED.source_position) END,
    source_revision_id = CASE WHEN (board_thread.source_epoch, board_thread.source_position)
      < (EXCLUDED.source_epoch, EXCLUDED.source_position)
      THEN EXCLUDED.source_revision_id ELSE board_thread.source_revision_id END,
    last_activity_at = GREATEST(board_thread.last_activity_at, EXCLUDED.last_activity_at),
    active_rank = content.board_thread_active_rank(
      board_thread.score,
      GREATEST(board_thread.last_activity_at, EXCLUDED.last_activity_at),
      statement_timestamp()
    ),
    hot_rank = content.board_thread_active_rank(board_thread.score, board_thread.created_at, statement_timestamp()),
    rank_refreshed_at = statement_timestamp()
WHERE (board_thread.source_epoch, board_thread.source_position)
    < (EXCLUDED.source_epoch, EXCLUDED.source_position)
   OR board_thread.last_activity_at < EXCLUDED.last_activity_at
RETURNING thread_id;
