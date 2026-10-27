WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_id::nullable(uuid) AS after_id, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT subject_id
  FROM library.entry AS fact CROSS JOIN input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND (input.after_id IS NULL OR fact.subject_id > input.after_id)
  ORDER BY subject_id
  LIMIT (SELECT page_limit FROM input)
), removed AS (
  DELETE FROM library.entry AS fact USING source, input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND fact.subject_id = source.subject_id
  RETURNING fact.subject_id
)
SELECT source.subject_id AS id, removed.subject_id IS NOT NULL AS removed
FROM source LEFT JOIN removed USING (subject_id)
ORDER BY source.subject_id;
