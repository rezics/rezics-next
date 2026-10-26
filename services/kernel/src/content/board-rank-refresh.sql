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
  SELECT board.realm_id, revision.created_at AS realm_revision_created_at
  FROM content.board AS board
  LEFT JOIN LATERAL (
    SELECT stored.created_at
    FROM community.realm AS realm
    JOIN community.realm_revision AS stored
      ON stored.route = realm.route
     AND stored.realm_id = realm.realm_id
     AND stored.revision_id = realm.head_revision_id
    WHERE realm.route = get_byte(uuid_send(board.realm_id), 10) * 256
                          + get_byte(uuid_send(board.realm_id), 11)
      AND realm.realm_id = board.realm_id
    LIMIT 1
  ) AS revision ON true
  WHERE board.route >= input.partition * 16
    AND board.route < (input.partition + 1) * 16
    AND board.route = candidate.route
    AND board.board_id = candidate.board_id
  LIMIT 1
) AS board ON true
WHERE candidate.route >= input.partition * 16
  AND candidate.route < (input.partition + 1) * 16
  AND candidate.active_rank <> 0
  AND candidate.rank_refreshed_at < input.at
  AND (
    candidate.rank_refreshed_at <= input.at - INTERVAL '10 minutes'
    OR board.realm_revision_created_at > candidate.rank_refreshed_at
       - GREATEST(INTERVAL '0', input.at - statement_timestamp())
  )
ORDER BY candidate.rank_refreshed_at, candidate.route, candidate.board_id, candidate.thread_id
LIMIT 500
FOR UPDATE OF candidate SKIP LOCKED;
