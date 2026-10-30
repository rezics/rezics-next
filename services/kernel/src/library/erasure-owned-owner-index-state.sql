-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT pin,collection_id FROM library.owner_index_state, input WHERE library.owner_index_state.route=input.route AND library.owner_index_state.account_id=input.account_id
  ORDER BY pin,collection_id LIMIT 100
)
DELETE FROM library.owner_index_state victim USING keys,input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.pin=keys.pin AND victim.collection_id=keys.collection_id
RETURNING true AS removed;
