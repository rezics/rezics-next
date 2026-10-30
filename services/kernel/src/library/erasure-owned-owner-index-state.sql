-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH keys AS MATERIALIZED (
  SELECT pin,collection_id FROM library.owner_index_state WHERE route=:route AND account_id=:account_id
  ORDER BY pin,collection_id LIMIT 100
)
DELETE FROM library.owner_index_state victim USING keys
WHERE victim.route=:route AND victim.account_id=:account_id AND victim.pin=keys.pin AND victim.collection_id=keys.collection_id
RETURNING true AS removed;
