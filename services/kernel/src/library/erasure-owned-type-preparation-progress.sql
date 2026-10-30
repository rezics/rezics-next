-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT preparation_id FROM library.type_preparation_progress, input
  WHERE library.type_preparation_progress.route=input.route AND library.type_preparation_progress.account_id=input.account_id
  ORDER BY preparation_id LIMIT 100
)
DELETE FROM library.type_preparation_progress AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.preparation_id=keys.preparation_id
RETURNING true AS removed;
