WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id FROM library.hosted_reading_fence, input
  WHERE library.hosted_reading_fence.route = input.route
    AND library.hosted_reading_fence.account_id = input.account_id
  ORDER BY subject_id LIMIT 100
), removed_checkpoints AS (
  DELETE FROM library.hosted_reading AS victim USING keys, input
  WHERE victim.route = input.route
    AND victim.account_id = input.account_id
    AND victim.subject_id = keys.subject_id
  RETURNING victim.subject_id
), removed_fences AS (
  DELETE FROM library.hosted_reading_fence AS victim USING keys, input
  WHERE victim.route = input.route
    AND victim.account_id = input.account_id
    AND victim.subject_id = keys.subject_id
  RETURNING true AS removed
)
SELECT removed FROM removed_fences;
