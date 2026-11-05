-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT reservation_id FROM library.shelf_type_reservation, input
  WHERE library.shelf_type_reservation.route=input.route AND library.shelf_type_reservation.account_id=input.account_id
  ORDER BY reservation_id LIMIT 100
)
DELETE FROM library.shelf_type_reservation AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.reservation_id=keys.reservation_id
RETURNING true AS removed;
