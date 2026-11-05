-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT library.owner_index_control.account_id FROM library.owner_index_control, input WHERE library.owner_index_control.route=input.route AND library.owner_index_control.account_id=input.account_id
  ORDER BY library.owner_index_control.account_id LIMIT 100
)
DELETE FROM library.owner_index_control victim USING keys,input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.account_id=keys.account_id
RETURNING true AS removed;
