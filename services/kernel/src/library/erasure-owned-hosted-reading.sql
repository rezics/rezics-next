WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id FROM library.hosted_reading, input
  WHERE library.hosted_reading.route = input.route AND library.hosted_reading.account_id = input.account_id
  ORDER BY subject_id LIMIT 100
)
DELETE FROM library.hosted_reading AS victim USING keys, input
WHERE victim.route = input.route AND victim.account_id = input.account_id AND victim.subject_id = keys.subject_id
RETURNING true AS removed;
