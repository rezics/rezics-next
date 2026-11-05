SELECT kind, state,
       to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at,
       to_char(purge_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purge_after,
       held
FROM semantic.context
WHERE route = :route::integer AND context_id = :context_id::uuid;
