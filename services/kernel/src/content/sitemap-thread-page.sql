SELECT thread_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at
FROM content.board_thread
WHERE route = :route::integer AND board_id = :board_id::uuid
  AND (created_at, thread_id) > (:created_at::timestamptz, :thread_id::uuid)
ORDER BY created_at, thread_id
LIMIT :limit::integer;
