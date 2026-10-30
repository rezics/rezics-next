-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT type_id FROM library.shelf_type_value, input
  WHERE library.shelf_type_value.route=input.route AND library.shelf_type_value.account_id=input.account_id
  ORDER BY type_id LIMIT 100
)
DELETE FROM library.shelf_type_value AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.type_id=keys.type_id
RETURNING true AS removed;
