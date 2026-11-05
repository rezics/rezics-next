-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT deletion_id FROM library.entry_deleted, input
  WHERE library.entry_deleted.route=input.route AND library.entry_deleted.account_id=input.account_id
  ORDER BY deletion_id LIMIT 100
)
DELETE FROM library.entry_deleted AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.deletion_id=keys.deletion_id
RETURNING true AS removed;
