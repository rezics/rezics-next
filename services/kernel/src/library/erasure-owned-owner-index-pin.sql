-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH keys AS MATERIALIZED (
  SELECT pin FROM library.owner_index_pin WHERE route=:route AND account_id=:account_id
  ORDER BY pin LIMIT 100
)
DELETE FROM library.owner_index_pin victim USING keys
WHERE victim.route=:route AND victim.account_id=:account_id AND victim.pin=keys.pin
RETURNING true AS removed;
