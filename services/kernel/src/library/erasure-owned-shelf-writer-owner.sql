-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT shelf_writer_owner.account_id FROM library.shelf_writer_owner, input
  WHERE library.shelf_writer_owner.route=input.route AND library.shelf_writer_owner.account_id=input.account_id
  ORDER BY shelf_writer_owner.account_id LIMIT 100
)
DELETE FROM library.shelf_writer_owner AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.account_id=keys.account_id
RETURNING true AS removed;
