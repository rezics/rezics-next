WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_id::nullable(uuid) AS after_id, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT target_id
  FROM library.follow AS fact CROSS JOIN input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND (input.after_id IS NULL OR fact.target_id > input.after_id)
  ORDER BY target_id
  LIMIT (SELECT page_limit FROM input)
), removed AS (
  DELETE FROM library.follow AS fact USING source, input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND fact.target_id = source.target_id
  RETURNING fact.target_id
)
SELECT source.target_id AS id, removed.target_id IS NOT NULL AS removed
FROM source LEFT JOIN removed USING (target_id)
ORDER BY source.target_id;
