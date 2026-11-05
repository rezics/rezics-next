-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT owner_write_counter.account_id FROM library.owner_write_counter, input
  WHERE library.owner_write_counter.route=input.route AND library.owner_write_counter.account_id=input.account_id
  ORDER BY owner_write_counter.account_id LIMIT 100
)
DELETE FROM library.owner_write_counter AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.account_id=keys.account_id
RETURNING true AS removed;
