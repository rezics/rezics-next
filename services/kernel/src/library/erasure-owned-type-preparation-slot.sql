-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT binding_digest FROM library.type_preparation_slot, input
  WHERE library.type_preparation_slot.route=input.route AND library.type_preparation_slot.account_id=input.account_id
  ORDER BY binding_digest LIMIT 100
)
DELETE FROM library.type_preparation_slot AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.binding_digest=keys.binding_digest
RETURNING true AS removed;
