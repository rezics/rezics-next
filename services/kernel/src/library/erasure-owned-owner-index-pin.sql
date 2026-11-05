-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT pin FROM library.owner_index_pin, input WHERE library.owner_index_pin.route=input.route AND library.owner_index_pin.account_id=input.account_id
  ORDER BY pin LIMIT 100
)
DELETE FROM library.owner_index_pin victim USING keys,input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.pin=keys.pin
RETURNING true AS removed;
