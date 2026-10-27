-- The board's newest `:limit` candidates in creation order that are still published and available. Candidate ids
-- carry no authority; the caller runs the shared thread disclosure on them.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :board_id::uuid AS board_id, :limit::integer AS candidate_limit
), newest AS (
  SELECT candidate.thread_id, candidate.created_at
  FROM input
  CROSS JOIN LATERAL (
    SELECT thread_id, created_at
    FROM content.board_thread
    WHERE route = input.route AND board_id = input.board_id
    ORDER BY created_at DESC, thread_id DESC
    LIMIT input.candidate_limit
  ) AS candidate
)
SELECT newest.thread_id,
       to_char(newest.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM newest
JOIN content.thread AS thread
  ON thread.route = get_byte(uuid_send(newest.thread_id), 10) * 256 + get_byte(uuid_send(newest.thread_id), 11)
 AND thread.thread_id = newest.thread_id
WHERE thread.board_id = (SELECT board_id FROM input)
  AND thread.visibility = 'published' AND thread.availability = 'available'
ORDER BY newest.created_at DESC, newest.thread_id DESC;
