WITH input AS NOT MATERIALIZED (
  SELECT :partition::integer AS partition, :at::timestamptz AS at
)
UPDATE content.board_thread AS candidate
SET score = batch.score,
    active_rank = batch.active_rank,
    hot_rank = batch.hot_rank,
    rank_refreshed_at = input.at
FROM jsonb_to_recordset(:updates::jsonb) AS batch(
  route integer, board_id uuid, thread_id uuid, score integer,
  active_rank double precision, hot_rank double precision
)
CROSS JOIN input
WHERE candidate.route >= input.partition * 16
  AND candidate.route < (input.partition + 1) * 16
  AND candidate.route = batch.route
  AND candidate.board_id = batch.board_id
  AND candidate.thread_id = batch.thread_id
RETURNING candidate.thread_id::text AS thread_id;
