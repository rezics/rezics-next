-- Internal identities, including erased rows; this query grants no disclosure permission.
SELECT revision_id,
       to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
FROM content.revision
WHERE route = :route::integer AND post_id = :post_id::uuid
  AND (recorded_at, revision_id) > (:at::timestamptz, :revision_id::uuid)
ORDER BY recorded_at ASC, revision_id ASC
LIMIT :limit::integer;
