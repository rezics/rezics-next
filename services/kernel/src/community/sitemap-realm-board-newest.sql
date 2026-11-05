SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.board
WHERE route = :route::integer AND realm_id = :id::uuid
ORDER BY board_id DESC
LIMIT 1;
