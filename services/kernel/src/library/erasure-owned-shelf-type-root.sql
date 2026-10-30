-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT digest FROM library.shelf_type_root, input
  WHERE library.shelf_type_root.route=input.route AND library.shelf_type_root.account_id=input.account_id
  ORDER BY digest LIMIT 100
)
DELETE FROM library.shelf_type_root AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.digest=keys.digest
RETURNING true AS removed;
