WITH input AS NOT MATERIALIZED (
  SELECT :at::timestamptz AS at, :partition::integer AS partition
)
SELECT candidate.route,
       candidate.board_id,
       candidate.thread_id,
       candidate.created_at,
       candidate.last_activity_at,
       board.realm_id
FROM content.board_thread AS candidate
CROSS JOIN input
LEFT JOIN LATERAL (
  SELECT board.realm_id
  FROM content.board AS board
  WHERE board.route >= input.partition * 16
    AND board.route < (input.partition + 1) * 16
    AND board.route = candidate.route
    AND board.board_id = candidate.board_id
  LIMIT 1
) AS board ON true
WHERE candidate.route >= input.partition * 16
  AND candidate.route < (input.partition + 1) * 16
  AND candidate.active_rank <> 0
  AND candidate.rank_refreshed_at <= input.at - INTERVAL '10 minutes'
ORDER BY candidate.rank_refreshed_at, candidate.route, candidate.board_id, candidate.thread_id
LIMIT 500
FOR UPDATE OF candidate SKIP LOCKED;
