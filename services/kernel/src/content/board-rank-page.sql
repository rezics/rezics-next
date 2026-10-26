-- Hot pages use this same bounded seek with candidate.active_rank replaced by candidate.hot_rank.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :board_id::uuid AS board_id,
         :active_rank::double precision AS active_rank, :thread_id::uuid AS thread_id,
         :has_after::boolean AS has_after, :limit::integer AS page_limit
)
SELECT candidate.thread_id, candidate.active_rank,
       to_char(candidate.rank_refreshed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS rank_refreshed_at
FROM input
JOIN content.board_thread AS candidate ON candidate.route = input.route AND candidate.board_id = input.board_id
WHERE (NOT input.has_after
       OR candidate.active_rank < input.active_rank
       OR (candidate.active_rank = input.active_rank AND candidate.thread_id > input.thread_id))
ORDER BY candidate.active_rank DESC, candidate.thread_id ASC
LIMIT (SELECT page_limit FROM input);
