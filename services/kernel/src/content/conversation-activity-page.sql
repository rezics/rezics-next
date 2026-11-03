WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.thread_id
  FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, thread_id uuid)
)
SELECT input.thread_id, contribution.post_id,
       contribution.opening,
       to_char(contribution.contributed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS contributed_at
FROM input
CROSS JOIN LATERAL (
  SELECT post_id, opening, contributed_at
  FROM content.conversation_activity_episode
  WHERE route = input.route AND thread_id = input.thread_id
    AND native_eligible AND contributed_at IS NOT NULL
  ORDER BY contributed_at DESC, post_id DESC
  LIMIT :limit::integer
) contribution;
