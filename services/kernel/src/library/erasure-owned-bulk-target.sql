-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT operation_id, ordinal FROM library.bulk_target, input
  WHERE library.bulk_target.route=input.route AND library.bulk_target.account_id=input.account_id
  ORDER BY operation_id, ordinal LIMIT 100
)
DELETE FROM library.bulk_target AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.operation_id=keys.operation_id AND victim.ordinal=keys.ordinal
RETURNING true AS removed;
