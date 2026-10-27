WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_id::nullable(uuid) AS after_id,
         :after_created_at::nullable(timestamptz) AS after_created_at, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT copy_id, created_at
  FROM library.copy AS fact CROSS JOIN input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND (input.after_created_at IS NULL
      OR (fact.created_at, fact.copy_id) > (input.after_created_at, input.after_id))
  ORDER BY created_at, copy_id
  LIMIT (SELECT page_limit FROM input)
), removed AS (
  DELETE FROM library.copy AS fact USING source, input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND fact.copy_id = source.copy_id AND fact.created_at = source.created_at
  RETURNING fact.copy_id
)
SELECT source.copy_id AS id,
       to_char(source.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
       removed.copy_id IS NOT NULL AS removed
FROM source LEFT JOIN removed USING (copy_id)
ORDER BY source.created_at, source.copy_id;
